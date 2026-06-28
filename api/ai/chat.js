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
    const history = priorMessages.slice(-12).map((item) => {
      let content = item.content || '';
      if (item.role === 'assistant') {
        const index = content.indexOf('Workspace:');
        if (index !== -1 && content.includes('All jobs sample:')) {
          content = content.substring(0, index).trim();
        }
      }
      return {
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content
      };
    });

    const model = process.env.HF_CHAT_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';
    const reply = await callHuggingFaceChat({
      model,
      messages: [
        {
          role: 'system',
          content: `You are Workcosmo AI, an internal workspace assistant for HR and recruiting teams.
You can read the workspace context and PERFORM ACTIONS on behalf of the user when asked.

SUPPORTED ACTIONS:
1. "create_job"
   Params: { "title": string (req), "department": string, "designation": string, "location": string, "priority": "Urgent"|"Medium"|"Low", "status": "Open"|"Draft"|"Closed", "budget": number (in LPA, e.g. 6), "requirements": array of strings, "skills": array of strings }
2. "update_record"
   Params: { "collection": "jobs"|"candidates"|"interviews"|"offers" (req), "id": string (req), "data": object (fields to update) (req) }
   Example: To close a job: { "collection": "jobs", "id": "job_id_here", "data": { "status": "Closed" } }
   Example: To update candidate name: { "collection": "candidates", "id": "cand_id_here", "data": { "name": "New Name" } }
3. "delete_record"
   Params: { "collection": "jobs"|"candidates"|"interviews"|"offers" (req), "id": string (req) }
   Example: To delete a candidate: { "collection": "candidates", "id": "cand_id_here" }
4. "create_candidate"
   Params: { "name": string (req), "email": string (req), "phone": string, "jobId": string (req), "stage": string, "source": string }
5. "schedule_interview"
   Params: { "candidateId": string (req), "dateTime": ISO-8601 string (req), "mode": string, "status": string, "interviewers": array of strings }
6. "create_offer"
   Params: { "candidateId": string (req), "designation": string (req), "status": "Draft"|"Sent"|"Accepted"|"Rejected" }

When the user asks you to perform one of these, execute it immediately by appending this EXACT JSON format to the very end of your response:
:::ACTION{"action":"action_name","params":{...}}:::

Always output the ACTION block at the end if you perform one. Be concise, accurate, and professional.

Use only the workspace context enclosed in the tags below to answer:
<context>
${contextBlock}
</context>

CRITICAL: Do NOT echo, quote, repeat or print the text headings of this context (like "Workspace:", "Open jobs sample:", "All jobs sample:", "Candidates sample:", "Interviews sample:", "Offers sample:", "Team sample:", "Departments list:", "Designations list:") in your response. Just write a direct, friendly human message.`
        },
        ...history,
        { role: 'user', content: String(message).trim() }
      ],
      temperature: 0.4
    });

    // Parse action if present
    const actionRegex = /:::ACTION(\{.*?\}):::/;
    const match = reply.match(actionRegex);
    let actionResult = null;
    let cleanReply = reply;

    if (match) {
      try {
        const actionData = JSON.parse(match[1]);
        const { executeAction } = require('../../lib/actionExecutor');
        actionResult = await executeAction(actionData.action, actionData.params, ctx);
        cleanReply = reply.replace(actionRegex, '').trim();
      } catch (err) {
        actionResult = { success: false, error: err.message };
        cleanReply = reply.replace(actionRegex, '').trim() + `\n\n*(Error performing action: ${err.message})*`;
      }
    }

    const now = new Date().toISOString();
    const userMessage = { role: 'user', content: String(message).trim(), createdAt: now };
    const assistantMessage = {
      role: 'assistant',
      content: cleanReply,
      createdAt: now,
      ...(actionResult ? { actionResult } : {})
    };

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
      reply: cleanReply,
      creditsUsed: 1,
      creditsRemaining,
      actionResult
    });
  } catch (error) {
    if (ctx && ledgerId) {
      await refundAiCredit(ctx.company.id, ledgerId, 1, error.message).catch(() => {});
    }
    sendError(res, error);
  }
};
