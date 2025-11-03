# RFP AI Agent (Bare Bones)

This repository contains a minimal full‑stack application that allows you to:

1. **Ingest your own documents** (CSV, XLSX, DOCX, PDF) into a local knowledge base that is persisted to a JSON file (or object storage) and vectorised with OpenAI embeddings.
2. **Chat with your knowledge base** using semantic search performed in memory on the stored embeddings.
3. **Generate a filled RFP report** by matching questions in an uploaded RFP with existing answers and synthesising new answers using GPT‑4.

The goal of this project is to provide a bare‑bones implementation you can deploy to [Vercel](https://vercel.com/) or any Node environment and adapt to your needs. It intentionally avoids most bells and whistles—there’s no authentication, no fancy UI framework, and no background workers—just the core functionality to get you up and running quickly.

## Getting Started

### 1. Persisting your knowledge base

This project stores your ingested Q&A pairs and their embeddings in a simple JSON file on disk. By default the file is saved to `/tmp/kb.json`. You can override this path by setting the `KB_PATH` environment variable when running or deploying the app.

If you are deploying to Vercel you should swap the file‑system based store for an object store such as [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) by modifying `lib/kbStore.ts`. The store implements two functions—`loadKb()` and `saveKb()`—which you can adapt to read and write your data from any source (e.g. object storage, database, etc.).

### 2. Configure environment variables

The app relies on the following environment variables:

- `OPENAI_API_KEY` – Your OpenAI API key with access to GPT‑4 and the embeddings endpoint.
- `KB_PATH` (optional) – The location on disk where the knowledge base file will be stored. Defaults to `/tmp/kb.json`.

When deploying on Vercel, add these variables in the *Environment Variables* section of your project. For local development, create a `.env.local` file at the root of `rfp-app`:

```bash
OPENAI_API_KEY=sk-...
# Optional: customise where your KB is stored
#KB_PATH=/tmp/kb.json
```

> **Note:** Because this is a bare‑bones project, it does not implement user authentication or row‑level security. If you intend to expose this publicly, you should add appropriate access controls to prevent unwanted access to your data.

### 3. Install dependencies and run locally

```bash
# Change into the project directory
cd rfp-app

# Install dependencies
npm install

# Run the development server
npm run dev

# Open http://localhost:3000 in your browser
```

### 4. Deploy to Vercel

Push the `rfp-app` folder to a Git repository (e.g. GitHub) and import it into Vercel. Make sure to configure the environment variables mentioned above. Vercel will detect the Next.js app automatically and build it.

## How it works

### Ingestion (`/api/ingest`)

When you upload one or more files via the **Ingest Knowledge Base** section, the API will:

1. Read each file into a buffer and determine its type based on the extension.
2. Use dedicated parsers (`xlsx`, `mammoth`, `pdf-parse`) to extract potential question/answer pairs:
   - For CSV/XLSX files, it looks for columns like “Q/Question/Prompt” and “A/Answer/Response”.
   - For DOCX/PDF files, it extracts raw text and asks GPT‑4 to locate Q&A pairs.
3. Ask GPT‑4 to classify each extracted pair as **VALID** or **GARBAGE**, discarding the latter.
4. Compute an embedding for each valid question using OpenAI’s `text-embedding-ada-002` model.
5. Upsert the question into the `kb_items` table:
   - If the question already exists, its answer list and embedding are updated.
   - Otherwise a new row is inserted.

### Chat (`/api/chat`)

The chat API accepts a user query (at least four characters). It computes the embedding of the query and calls the `match_kb_items` function to fetch the top five closest questions in your knowledge base. The response includes the matched questions, their associated answers and a similarity score.

### Generate Report (`/api/generate-report`)

When you upload an RFP document, the API will:

1. Extract questions from the file using the same parsers used during ingestion (answers are ignored).
2. For each question:
   - Compute its embedding and query Supabase to find the top semantic matches.
   - Perform a fuzzy match against all knowledge‑base questions to identify lexically similar questions.
   - Ask GPT‑4 to choose the single best existing answer among the semantic matches.
   - Ask GPT‑4 to **synthesise a final answer** using all available context.
3. Compile the results into a DOCX document via the `docx` library. Each question yields a section containing:
   - A list of the top semantic and fuzzy matches.
   - The best existing answer selected by GPT‑4.
   - The AI‑generated final answer.
   - The raw answers from your knowledge base.

The resulting file is streamed back as `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Your browser will prompt you to download it.

## Limitations and future improvements

This project is intentionally minimalistic. Here are a few directions you may wish to explore:

- **Authentication and RLS:** At the moment, anyone with your API keys could read/write your knowledge base. Consider adding Supabase Auth and row‑level security policies.
- **Background processing:** Large documents may take a while to parse and embed. Moving ingestion and report generation to background jobs (e.g. Supabase Edge Functions or serverless functions) will improve responsiveness.
- **Better parsing:** The GPT‑based extraction works surprisingly well, but you can improve accuracy by using bespoke parsers or metadata extraction models tailored to your document structure.
- **Streaming chat:** For a more natural chat experience, stream GPT responses back to the client instead of waiting for the full answer.

Feel free to build upon this foundation and adapt it to your specific RFP workflows!