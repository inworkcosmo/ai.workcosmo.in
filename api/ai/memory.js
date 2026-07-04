const {
  getAuthedContext,
  setCors,
  sendError
} = require('../../lib/aiAuth');
const {
  loadMemories,
  saveMemory,
  deleteMemory
} = require('../../lib/memoryManager');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ctx = await getAuthedContext(req);

    if (req.method === 'GET') {
      const memories = await loadMemories(ctx.user.id, ctx.company.id);
      return res.status(200).json({ success: true, memories });
    }

    if (req.method === 'POST') {
      const { content, category } = req.body || {};
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Content is required.' });
      }

      const memory = await saveMemory(ctx.user.id, ctx.company.id, content, category || 'fact', 'manual');
      return res.status(200).json({ success: true, memory });
    }

    if (req.method === 'DELETE') {
      const memoryId = req.query?.memoryId || req.body?.memoryId;
      if (!memoryId) {
        return res.status(400).json({ error: 'memoryId is required.' });
      }

      const result = await deleteMemory(memoryId, ctx.user.id);
      return res.status(200).json({ success: true, deleted: result.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
