const {
  db,
  admin,
  getAuthedContext,
  reserveAiCredit,
  completeAiCredit,
  refundAiCredit,
  callHuggingFaceChat,
  companyAiCreditsRemaining,
  setCors,
  sendError
} = require('../../lib/aiAuth');
const { buildCompanyContext, formatContextForPrompt } = require('../../lib/companyContext');

function conversationTitle(message = '') {
  const trimmed = String(message).trim();
  if (!trimmed) return 'New chat';
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

async function loadConversation(conversationId, companyId, userId) {
  const snap = await db.collection('aiConversations').doc(conversationId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.companyId !== companyId || data.userId !== userId) return null;
  return { id: snap.id, ...data };
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let ctx;
  let ledgerId;
  try {
    ctx = await getAuthedContext(req);
    const { message, conversationId } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    ledgerId = await reserveAiCredit(ctx.company.id, ctx.user.id, 'workspace_chat', 1);

    let conversation = null;
    if (conversationId) {
      conversation = await loadConversation(conversationId, ctx.company.id, ctx.user.id);
      if (!conversation) {
        const err = new Error('Conversation not found.');
        err.statusCode = 404;
        throw err;
      }
    }

    const context = await buildCompanyContext(ctx.company.id, ctx.company);
    const contextBlock = formatContextForPrompt(context);
    const priorMessages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const history = priorMessages.slice(-12).map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.content
    }));

    const model = process.env.HF_CHAT_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';
    const reply = await callHuggingFaceChat({
      model,
      messages: [
        {
          role: 'system',
          content: `You are Workcosmo AI, an internal workspace assistant for HR and recruiting teams.
Answer using ONLY the workspace context below. Be concise, accurate, and professional.
If data is missing, say so. Never invent candidate names, job IDs, or record details.
When referencing records, include their IDs from the context when helpful.

${contextBlock}`
        },
        ...history,
        { role: 'user', content: String(message).trim() }
      ],
      temperature: 0.4
    });

    const now = new Date().toISOString();
    const userMessage = { role: 'user', content: String(message).trim(), createdAt: now };
    const assistantMessage = { role: 'assistant', content: reply, createdAt: now };

    let savedId = conversation?.id;
    if (conversation) {
      const messages = [...priorMessages, userMessage, assistantMessage];
      await db.collection('aiConversations').doc(conversation.id).update({
        messages,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      const ref = await db.collection('aiConversations').add({
        companyId: ctx.company.id,
        userId: ctx.user.id,
        title: conversationTitle(message),
        messages: [userMessage, assistantMessage],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      savedId = ref.id;
    }

    await completeAiCredit(ledgerId, 'succeeded', {
      action: 'workspace_chat',
      conversationId: savedId
    });

    const creditsRemaining = companyAiCreditsRemaining({
      ...ctx.company,
      aiCreditsRemaining: companyAiCreditsRemaining(ctx.company) - 1
    });

    res.status(200).json({
      success: true,
      conversationId: savedId,
      reply,
      creditsUsed: 1,
      creditsRemaining
    });
  } catch (error) {
    if (ctx && ledgerId) {
      await refundAiCredit(ctx.company.id, ledgerId, 1, error.message).catch(() => {});
    }
    sendError(res, error);
  }
};
