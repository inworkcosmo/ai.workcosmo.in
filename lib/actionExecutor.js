const { db, admin } = require('./aiAuth');

function stampCreate(companyId, userId, data = {}) {
  return {
    ...data,
    companyId,
    ownerId: userId,
    createdBy: userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function executeAction(action, params, ctx) {
  const companyId = ctx.company.id;
  const userId = ctx.user.id;

  if (!action) {
    throw new Error('Action name is required.');
  }

  switch (action) {
    case 'create_job': {
      const {
        title,
        department,
        designation,
        location,
        priority = 'Medium',
        status = 'Open',
        budget, // Expect number in LPA, e.g. 8 for 8,000,000 or full amount if already large
        requirements = [],
        skills = []
      } = params;

      if (!title) throw new Error('Job title is required.');

      // Normalize budget: convert LPA (e.g. 5, 8.5) to full INR.
      let numericBudget = null;
      if (budget) {
        const val = Number(budget);
        if (!isNaN(val)) {
          numericBudget = val < 100 ? val * 100000 : val;
        }
      }

      const jobData = stampCreate(companyId, userId, {
        title,
        department: department || 'General',
        designation: designation || title,
        location: location || 'Remote',
        priority,
        status,
        budget: numericBudget,
        requirements: Array.isArray(requirements) ? requirements : String(requirements).split('\n').map(s => s.trim()).filter(Boolean),
        keySkills: Array.isArray(skills) ? skills : String(skills).split('\n').map(s => s.trim()).filter(Boolean),
        skills: Array.isArray(skills) ? skills : String(skills).split('\n').map(s => s.trim()).filter(Boolean),
        branchName: 'Headquarters',
        branchLocation: ctx.company.location || 'Remote'
      });

      const ref = await db.collection('jobs').add(jobData);
      return {
        success: true,
        summary: `Created job posting "${title}" in ${jobData.department}`,
        id: ref.id
      };
    }

    case 'update_job_status': {
      const { jobId, status } = params;
      if (!jobId) throw new Error('jobId is required.');
      if (!['Open', 'Closed', 'Draft'].includes(status)) {
        throw new Error('Status must be Open, Closed, or Draft.');
      }

      const jobRef = db.collection('jobs').doc(jobId);
      const snap = await jobRef.get();
      if (!snap.exists) throw new Error('Job not found.');
      if (snap.data().companyId !== companyId) throw new Error('Access denied to job.');

      await jobRef.update({
        status,
        updatedBy: userId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        summary: `Updated job "${snap.data().title}" status to ${status}`,
        id: jobId
      };
    }

    case 'create_candidate': {
      const { name, email, phone = '', jobId, stage = 'Screening', source = 'AI Assistant' } = params;
      if (!name || !email || !jobId) {
        throw new Error('Candidate name, email, and jobId are required.');
      }

      // Verify job exists
      const jobSnap = await db.collection('jobs').doc(jobId).get();
      if (!jobSnap.exists) throw new Error('Associated Job not found.');
      if (jobSnap.data().companyId !== companyId) throw new Error('Access denied to job.');

      const candidateData = stampCreate(companyId, userId, {
        name,
        email,
        phone,
        jobId,
        stage,
        source
      });

      const ref = await db.collection('candidates').add(candidateData);
      return {
        success: true,
        summary: `Added candidate "${name}" for job "${jobSnap.data().title}"`,
        id: ref.id
      };
    }

    case 'schedule_interview': {
      const { candidateId, dateTime, mode = 'Online', status = 'Scheduled', interviewers = [] } = params;
      if (!candidateId || !dateTime) {
        throw new Error('candidateId and dateTime are required.');
      }

      // Verify candidate exists
      const candSnap = await db.collection('candidates').doc(candidateId).get();
      if (!candSnap.exists) throw new Error('Candidate not found.');
      if (candSnap.data().companyId !== companyId) throw new Error('Access denied to candidate.');

      const interviewData = stampCreate(companyId, userId, {
        candidateId,
        dateTime,
        mode,
        status,
        interviewers: Array.isArray(interviewers) ? interviewers : [interviewers]
      });

      const ref = await db.collection('interviews').add(interviewData);
      return {
        success: true,
        summary: `Scheduled ${mode} interview for ${candSnap.data().name} at ${dateTime}`,
        id: ref.id
      };
    }

    case 'create_offer': {
      const { candidateId, designation, status = 'Draft' } = params;
      if (!candidateId || !designation) {
        throw new Error('candidateId and designation are required.');
      }

      // Verify candidate exists
      const candSnap = await db.collection('candidates').doc(candidateId).get();
      if (!candSnap.exists) throw new Error('Candidate not found.');
      if (candSnap.data().companyId !== companyId) throw new Error('Access denied to candidate.');

      const offerData = stampCreate(companyId, userId, {
        candidateId,
        designation,
        status
      });

      const ref = await db.collection('offers').add(offerData);
      return {
        success: true,
        summary: `Created offer for ${candSnap.data().name} as ${designation}`,
        id: ref.id
      };
    }

    default:
      throw new Error(`Action "${action}" is not supported.`);
  }
}

module.exports = {
  executeAction
};
