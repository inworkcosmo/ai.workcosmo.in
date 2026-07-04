const { db, admin } = require('./aiAuth');

async function loadMemories(userId, companyId) {
  const snap = await db.collection('aiMemories')
    .where('userId', '==', userId)
    .where('companyId', '==', companyId)
    .limit(50)
    .get();

  return snap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || null,
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || null
    };
  });
}

async function saveMemory(userId, companyId, content, category = 'fact', source = 'auto') {
  if (!content || !content.trim()) {
    throw new Error('Memory content is required.');
  }

  // Check if this memory or preference already exists to avoid duplication
  const existingSnap = await db.collection('aiMemories')
    .where('userId', '==', userId)
    .where('companyId', '==', companyId)
    .where('content', '==', content.trim())
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const doc = existingSnap.docs[0];
    return { id: doc.id, ...doc.data(), duplicated: true };
  }

  const memoryRef = db.collection('aiMemories').doc();
  const memoryData = {
    userId,
    companyId,
    content: content.trim(),
    category: category || 'fact', // 'preference' | 'fact' | 'instruction'
    source: source || 'auto', // 'auto' | 'manual'
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await memoryRef.set(memoryData);
  return { id: memoryRef.id, ...memoryData };
}

async function deleteMemory(memoryId, userId) {
  const docRef = db.collection('aiMemories').doc(memoryId);
  const snap = await docRef.get();
  
  if (!snap.exists) {
    throw new Error('Memory not found.');
  }

  const data = snap.data();
  if (data.userId !== userId) {
    throw new Error('Access denied.');
  }

  await docRef.delete();
  return { id: memoryId, success: true };
}

module.exports = {
  loadMemories,
  saveMemory,
  deleteMemory
};
