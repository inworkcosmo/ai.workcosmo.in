const {
  db,
  admin,
  getAuthedContext,
  reserveAiCredit,
  completeAiCredit,
  refundAiCredit,
  callHuggingFaceChat,
  companyAiCreditsRemaining,
  checkRateLimit,
  setCors,
  sendError
} = require('../../lib/aiAuth');
const { buildCompanyContext, formatContextForPrompt } = require('../../lib/companyContext');
const { loadMemories } = require('../../lib/memoryManager');

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
    const { message, conversationId, truncateFromIndex } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    ledgerId = await reserveAiCredit(ctx.company.id, ctx.user.id, 'workspace_chat', 1);

    // Rate limiting
    const rateCheck = checkRateLimit(ctx.user.id);
    if (!rateCheck.allowed) {
      const err = new Error(`Too many requests. Please wait ${rateCheck.retryAfter} seconds.`);
      err.statusCode = 429;
      throw err;
    }

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

    // Personalization memories
    const memories = await loadMemories(ctx.user.id, ctx.company.id);
    const memoryBlock = memories.length > 0
      ? memories.map(m => `- ${m.content} (Category: ${m.category})`).join('\n')
      : 'No stored memories about this user yet.';

    let priorMessages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (typeof truncateFromIndex === 'number' && truncateFromIndex >= 0) {
      priorMessages = priorMessages.slice(0, truncateFromIndex);
    }
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

    // Set streaming headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const hfResponse = await callHuggingFaceChat({
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
7. "save_memory"
   Params: { "content": string (req), "category": "preference"|"fact"|"instruction" (req) }
   Example: :::ACTION{"action":"save_memory","params":{"content":"User prefers candidate tables sorted by status","category":"preference"}}:::

TONE AND STYLE:
Be warm, conversational, friendly, and helpful. Use a natural conversational flow. Avoid robotic, overly brief, or dry replies.
Use structured markdown tables where appropriate to present lists, comparisons, or summaries of candidates, jobs, interviews, or offers (e.g., using columns like Title/Name, Department/Email, Status/Stage, Location/Date). This makes tabular workspace information clean and readable.

STRICT ACTION DECISION RULES:
- ONLY output an action block if the user explicitly requested that specific operation (e.g. "delete this candidate" or "create a new job").
- NEVER output database action blocks (like create_job or delete_record) when the user is only asking a question, chatting, writing emails, drafting LinkedIn posts, or writing copy.
- DO NOT duplicate action blocks. Never output multiple action blocks doing the same thing.
- When deleting or updating, look up the record ID in the <context> first. Only output delete_record with the exact ID from the context. Do NOT guess the ID, and NEVER create a new record instead of deleting/updating one.
- If the user asks to delete a job, only output ONE "delete_record" action block for that job ID. Do NOT output a "create_job" block.

ACTION CONFIRMATION & EXECUTION:
Whenever the user asks you to perform an action (like creating a job, adding a candidate, scheduling an interview, or updating records), output the corresponding ACTION blocks at the very end of your response.
CRITICAL: In your text response, you must speak in the PROPOSAL or FUTURE tense (e.g., "I have drafted a job posting proposal for you" or "I have prepared the interview schedule plan"). Do NOT say "I have created the job" or "I have scheduled the interview" in past tense, as the action is not executed yet. Explain to the user that they need to click the "Execute Plan" button on the confirmation card below to actually run the actions on the server.

MULTIPLE ACTIONS & ID PLACEHOLDERS:
When executing a multi-action plan, a subsequent action might depend on the ID of a record created in a previous step (e.g. creating a candidate needs the jobId from the job creation step). You can link them using placeholders:
- In the action that creates the first record, add a top-level property "id_placeholder": "some_unique_name".
- In the parameters of any subsequent action, reference the ID as "$some_unique_name".
Example:
:::ACTION{"action":"create_job","id_placeholder":"dev_job","params":{"title":"Developer",...}}:::
:::ACTION{"action":"create_candidate","params":{"name":"Bob","jobId":"$dev_job",...}}:::

PERSONALIZATION & MEMORY:
You MUST actively use the provided user memories to personalize, contextualize, and enhance your responses. Do not ignore them; integrate them seamlessly. For example, address the user by their name, adjust details based on their role, department, or location, and recall preferences they shared.
When the user explicitly states a preference, a key fact about themselves or their workflow, or requests that you remember something, you MUST output the "save_memory" action block at the very end of your response to persist it.
Example: To remember the user's name is Chandan Singh and they are an HR, output:
:::ACTION{"action":"save_memory","params":{"content":"User's name is Chandan Singh, HR at Brawn Laboratories Ltd","category":"fact"}}:::

USER MEMORIES:
<memories>
${memoryBlock}
</memories>

Always output the ACTION blocks at the very end. Keep the conversational part warm and friendly.

Use only the workspace context enclosed in the tags below to answer:
<context>
${contextBlock}
</context>

CRITICAL: Do NOT echo, quote, repeat, print, or output any XML-like tags (such as <memories>, </memories>, <context>, </context>, or any custom tags like <user ... />) in your response. Just write a direct, friendly human message. Do NOT tell the user you are updating memory XML; use the "save_memory" ACTION block to save facts.`
        },
        ...history,
        { role: 'user', content: String(message).trim() }
      ],
      temperature: 0.4,
      stream: true
    });

    let reply = '';
    let isBufferingAction = false;
    let actionBuffer = '';

    const decoder = new TextDecoder('utf-8');
    let streamBuffer = '';
    for await (const chunk of hfResponse.body) {
      streamBuffer += decoder.decode(chunk, { stream: true });
      let lineBreakIndex;
      while ((lineBreakIndex = streamBuffer.indexOf('\n')) !== -1) {
        const line = streamBuffer.slice(0, lineBreakIndex).trim();
        streamBuffer = streamBuffer.slice(lineBreakIndex + 1);

        if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            break;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              if (!isBufferingAction) {
                const possibleActionStartIndex = (reply + token).indexOf(':::');
                if (possibleActionStartIndex !== -1) {
                  isBufferingAction = true;
                  const currentReplyLen = reply.length;
                  const splitIndex = possibleActionStartIndex - currentReplyLen;
                  const cleanPart = token.slice(0, splitIndex);
                  const actionPart = token.slice(splitIndex);

                  if (cleanPart) {
                    res.write(`data: ${JSON.stringify({ token: cleanPart })}\n\n`);
                  }
                  actionBuffer += actionPart;
                } else {
                  res.write(`data: ${JSON.stringify({ token })}\n\n`);
                }
              } else {
                actionBuffer += token;
              }
              reply += token;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    // Parse proposed actions if present (supports multiple)
    const actionRegex = /:::ACTION(\{.*?\}):::/g;
    const matches = [...reply.matchAll(actionRegex)];
    let proposedActions = [];
    let cleanReply = reply.replace(actionRegex, '').trim();

    if (matches.length > 0) {
      for (const match of matches) {
        try {
          const actionData = JSON.parse(match[1]);
          if (actionData.action === 'save_memory') {
            const { saveMemory } = require('../../lib/memoryManager');
            await saveMemory(ctx.user.id, ctx.company.id, actionData.params.content, actionData.params.category || 'fact', 'auto');
          } else if (actionData.action === 'delete_memory') {
            const { deleteMemory } = require('../../lib/memoryManager');
            await deleteMemory(actionData.params.id, ctx.user.id);
          } else {
            proposedActions.push(actionData);
          }
        } catch (e) {
          // Ignore json parse error of action block
        }
      }
    }

    const now = new Date().toISOString();
    const userMessage = { role: 'user', content: String(message).trim(), createdAt: now };
    const assistantMessage = {
      role: 'assistant',
      content: cleanReply,
      createdAt: now
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

    res.write(`data: ${JSON.stringify({
      done: true,
      conversationId: savedId,
      creditsRemaining,
      proposedActions
    })}\n\n`);
    res.end();
  } catch (error) {
    if (ctx && ledgerId) {
      await refundAiCredit(ctx.company.id, ledgerId, 1, error.message).catch(() => {});
    }
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message || 'Unexpected server error.' })}\n\n`);
      res.end();
    } else {
      sendError(res, error);
    }
  }
};
