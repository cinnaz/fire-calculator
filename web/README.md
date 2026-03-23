# Fire Calculator

Browser-based FIRE planning app with scenario editing, tax-aware cash flow inputs, and Supabase-backed account sync.

## Local development

```bash
npm install
npm run dev
```

## Supabase setup

1. Create a Supabase project.
2. In the Supabase SQL editor, run [supabase/schema.sql](/Users/sinanzhang/Documents/FireCalculator/web/supabase/schema.sql).
3. Copy [.env.example](/Users/sinanzhang/Documents/FireCalculator/web/.env.example) to `.env` and fill in:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

4. In Supabase Auth, enable email/password sign-in.
5. If you want email confirmation, keep it enabled in Supabase Auth settings. The app will still let users create accounts, then confirm by email.

## Verification

```bash
npm test
npm run lint
npm run build
```
