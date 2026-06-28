const { db } = require('./aiAuth');

const TENANT_COLLECTIONS = [
  { name: 'jobs', limit: 25, map: (id, d) => ({ id, title: d.title, department: d.department, status: d.status, location: d.location }) },
  { name: 'candidates', limit: 30, map: (id, d) => ({ id, name: d.name, email: d.email, jobId: d.jobId, stage: d.stage || d.status, source: d.source }) },
  { name: 'interviews', limit: 20, map: (id, d) => ({ id, candidateId: d.candidateId, dateTime: d.dateTime, mode: d.mode, status: d.status }) },
  { name: 'offers', limit: 15, map: (id, d) => ({ id, candidateId: d.candidateId, status: d.status, designation: d.designation }) },
  { name: 'masters_departments', limit: 50, map: (id, d) => ({ name: d.name }) },
  { name: 'masters_designations', limit: 50, map: (id, d) => ({ name: d.name }) }
];

async function loadCollectionSummary(companyId, { name, limit: max, map }) {
  const snap = await db.collection(name)
    .where('companyId', '==', companyId)
    .limit(max)
    .get();
  return snap.docs.map((doc) => map(doc.id, doc.data()));
}

async function buildCompanyContext(companyId, company) {
  const [jobs, candidates, interviews, offers, depts, desigs] = await Promise.all(
    TENANT_COLLECTIONS.map((cfg) => loadCollectionSummary(companyId, cfg))
  );

  const usersSnap = await db.collection('users')
    .where('companyId', '==', companyId)
    .limit(30)
    .get();
  const team = usersSnap.docs.map((doc) => {
    const d = doc.data();
    return { name: d.name, email: d.email, role: d.role, status: d.status };
  });

  return {
    workspace: {
      id: companyId,
      name: company.companyName || company.name || companyId,
      status: company.status,
      industry: company.industry || null
    },
    counts: {
      jobs: jobs.length,
      candidates: candidates.length,
      interviews: interviews.length,
      offers: offers.length,
      team: team.length
    },
    jobs,
    candidates,
    interviews,
    offers,
    team,
    departments: depts.map(d => d.name).filter(Boolean),
    designations: desigs.map(d => d.name).filter(Boolean)
  };
}

function formatContextForPrompt(context) {
  return `Workspace: ${context.workspace.name} (${context.workspace.id})
Departments list: ${JSON.stringify(context.departments)}
Designations list: ${JSON.stringify(context.designations)}
Open jobs sample: ${JSON.stringify(context.jobs.filter((j) => j.status === 'Open').slice(0, 10))}
All jobs sample: ${JSON.stringify(context.jobs.slice(0, 15))}
Candidates sample: ${JSON.stringify(context.candidates.slice(0, 15))}
Interviews sample: ${JSON.stringify(context.interviews.slice(0, 10))}
Offers sample: ${JSON.stringify(context.offers.slice(0, 10))}
Team sample: ${JSON.stringify(context.team.slice(0, 15))}`;
}

module.exports = {
  buildCompanyContext,
  formatContextForPrompt
};
