# Workcosmo AI

Company-scoped AI chat assistant at `ai.workcosmo.in`.

## Stack

- **Frontend**: static app with Space SSO (`auth-guard.js`)
- **API**: Vercel serverless routes under `/api/ai/*`
- **LLM**: Hugging Face Inference (`HF_API_TOKEN`, `HF_CHAT_MODEL`)
- **Database**: Firestore for `aiConversations`, `aiCreditLedger`, and company credit balances

## Local dev

```bash
npm install
npm run dev
```

Open via Space dock or `http://localhost:8095/index.html?companyId=YOUR_CLIENT_ID`.

API routes require Vercel (`vercel dev`) or deploy to `ai.workcosmo.in` — local live-server does not run `/api`.

## Vercel env

- `FIREBASE_SERVICE_ACCOUNT` — Firebase Admin JSON
- `HF_API_TOKEN` — Hugging Face API token
- `HF_CHAT_MODEL` — optional, default `meta-llama/Llama-3.1-8B-Instruct`

## API

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ai/chat` | POST | Send message, deduct 1 credit, save to Firestore |
| `/api/ai/conversations` | GET | List user chats |
| `/api/ai/conversations` | POST | Load one chat |
| `/api/ai/conversations` | DELETE | Delete a chat |

## Credits

Each chat message reserves 1 AI credit from `companies.aiCreditsRemaining` and logs usage in `aiCreditLedger`.
