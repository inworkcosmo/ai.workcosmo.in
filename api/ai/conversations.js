const {
  db,
  getAuthedContext,
  setCors,
  sendError
} = require('../../lib/aiAuth');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ctx = await getAuthedContext(req);

    if (req.method === 'GET') {
      const snap = await db.collection('aiConversations')
        .where('userId', '==', ctx.user.id)
        .limit(100)
        .get();

      const conversations = snap.docs
        .filter((doc) => doc.data().companyId === ctx.company.id)
        .map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            title: data.title || 'New chat',
            updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || null,
            messageCount: Array.isArray(data.messages) ? data.messages.length : 0
          };
        })
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

      return res.status(200).json({ success: true, conversations });
    }

    if (req.method === 'POST') {
      const { conversationId } = req.body || {};
      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required.' });
      }

      const snap = await db.collection('aiConversations').doc(conversationId).get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      const data = snap.data();
      if (data.companyId !== ctx.company.id || data.userId !== ctx.user.id) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      return res.status(200).json({
        success: true,
        conversation: {
          id: snap.id,
          title: data.title || 'New chat',
          messages: data.messages || [],
          updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.updatedAt || null
        }
      });
    }

    if (req.method === 'DELETE') {
      const conversationId = req.query?.conversationId || req.body?.conversationId;
      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required.' });
      }

      const snap = await db.collection('aiConversations').doc(conversationId).get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      const data = snap.data();
      if (data.companyId !== ctx.company.id || data.userId !== ctx.user.id) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      await db.collection('aiConversations').doc(conversationId).delete();
      return res.status(200).json({ success: true, deleted: conversationId });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
