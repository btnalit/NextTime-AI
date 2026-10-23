---
name: kb-retrieval
description: 从已接入的知识库里按问题检索相关内容：先确认有哪些知识库和文档，再检索，回答只用检索到的片段并注明出处，找不到就直说。
applicable:
  objectTypes:
    - KnowledgeBase
    - Document
---

# Knowledge base retrieval

Use this when your task asks a question that the workspace's knowledge bases may answer — a
procedure, a policy, a past decision, the content of a document.

## 1. Find where the answer could be

- `list_allowed_operations` lists the read-only operations you may call through
  `observe_operation`. On a connected RAGFlow system they are its knowledge bases (`kb.list`),
  the documents in one of them (`kb.documents`) and a search across them (`retrieve`).
- Call `kb.list` first. Pick the knowledge bases whose name or description fits the question;
  when none clearly does, search all of them rather than guessing one.
- `kb.documents` tells you what a knowledge base holds and whether each document is parsed. A
  document that is not parsed yet cannot be searched: say so instead of concluding it has nothing.
- The workspace may also record knowledge bases and documents (`search`, `get_object`); the live
  system is what you answer from.

## 2. Retrieve

- Call `retrieve` with the question in plain words and the `dataset_ids` you picked. Ask again
  with other words, or narrower `document_ids`, when the first chunks miss the point — two or
  three searches, not dozens.
- Keep what each chunk says, the knowledge base and document it came from, and its similarity.

## 3. Answer only from what you retrieved

- Answer with the chunks that support it, each with its source: the knowledge base, the document
  name and its id. Quote briefly where the exact wording matters.
- When the chunks disagree, show both and say which document says what; do not pick one silently.
- When nothing relevant comes back, say that the knowledge bases you searched do not answer it,
  and which ones those were. Never fill the gap from your own knowledge as if a document said it.

## 4. Report

- `summary`: the answer, with its sources.
- `findings`: one entry per source used — knowledge base, document, what it says.
- `evidence`: the `retrieve` results you relied on (the chunk text and its document).
- `factsToAssert`: only what a document states plainly and the task needs recorded; never your
  own conclusion from it.
- You cannot upload, parse or change anything in a knowledge base. If a document needs parsing
  before it can be searched, recommend it in `summary` so the agent that invoked you can ask a
  person.
