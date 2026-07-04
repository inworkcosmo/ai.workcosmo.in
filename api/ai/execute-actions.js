const {
  db,
  admin,
  getAuthedContext,
  setCors,
  sendError
} = require('../../lib/aiAuth');
const { executeAction } = require('../../lib/actionExecutor');
const { bustCompanyContextCache } = require('../../lib/companyContext');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ctx = await getAuthedContext(req);
    const { conversationId, actions } = req.body || {};

    if (!conversationId || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'conversationId and actions array are required.' });
    }

    // Load conversation
    const docRef = db.collection('aiConversations').doc(conversationId);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    const convData = snap.data();
    if (convData.companyId !== ctx.company.id || convData.userId !== ctx.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Execute all proposed actions
    const actionResults = [];
    const placeholders = {};

    for (const actionData of actions) {
      // Substitute placeholders
      if (actionData.params && typeof actionData.params === 'object') {
        for (const [key, val] of Object.entries(actionData.params)) {
          if (typeof val === 'string' && val.startsWith('$')) {
            const pk = val.slice(1);
            if (placeholders[pk]) {
              actionData.params[key] = placeholders[pk];
            }
          } else if (Array.isArray(val)) {
            actionData.params[key] = val.map(item => {
              if (typeof item === 'string' && item.startsWith('$')) {
                const pk = item.slice(1);
                return placeholders[pk] || item;
              }
              return item;
            });
          }
        }
      }

      const result = await executeAction(actionData.action, actionData.params, ctx);
      actionResults.push(result);

      if (actionData.id_placeholder && result.success && result.id) {
        placeholders[actionData.id_placeholder] = result.id;
      }
    }

    // Bust context cache since records were mutated
    bustCompanyContextCache(ctx.company.id);

    // Update conversation: find the last assistant message and append actionResults
    const messages = convData.messages || [];
    let updated = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i].actionResults = actionResults;
        updated = true;
        break;
      }
    }

    if (updated) {
      await docRef.update({
        messages,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({
      success: true,
      actionResults
    });
  } catch (error) {
    sendError(res, error);
  }
};
