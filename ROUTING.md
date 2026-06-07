# How LocalClaw Routes Messages: A Deep Dive

*How a local AI agent classifies user intent and dispatches to the right specialist — without cloud APIs, with 15 categories, and a multi-layer fallback system that handles everything from "hi" to "research AAPL stock and make me a deck."*

---

## The Problem

You have 39 tools, 12 pipelines, and 15 categories. A user sends "search for tech events near me." Does that go to:
- **web_search** (search the internet)?
- **multi** (browse Eventbrite with the browser tool)?
- **chat** (answer from memory)?
- **personal** (check the calendar)?

A cloud model like GPT-4 handles this with a massive context window and strong instruction following. A local 14B model needs a harness. That harness is the routing system.

---

## Architecture Overview

Every message flows through a multi-layer pipeline before reaching a specialist. Each layer narrows the decision. By the time a message reaches a specialist, the routing is deterministic and auditable.

```
┌─────────────────────────────────────────────────────────┐
│                    Inbound Message                       │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [1] FILE TYPE ROUTING                                  │
│  Images → vision → chat                                 │
│  Data files (.csv, .xlsx, .json) → analytics            │
│  PDFs → text extraction → normal routing                │
│  Text files → ask user (knowledge base or read as text) │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [2] PRE-MODEL OVERRIDES                                │
│  High-confidence regex patterns that skip the model:    │
│  • URLs → website                                       │
│  • Email/calendar words + time context → personal       │
│  • "make a PDF report" → research                       │
│  • "go to [site]" → multi                               │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [3] STICKY ROUTING                                     │
│  Mid-conversation? Stay on the same category unless:    │
│  • Explicit task command ("search for X", "create a")   │
│  • Greeting ("hi", "hello") — new conversation          │
│  • Strong new-topic signal ("look up", "schedule")      │
│  Only chat and memory are sticky — pipelines don't hold │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [4] MODEL CLASSIFICATION                               │
│  phi4:14b classifies into 15 categories                 │
│  • Temperature 0.1 (deterministic)                      │
│  • ~50ms per classification                             │
│  • 20 tokens max (just the category name)               │
│  • Minimal prompt: categories + descriptions + message  │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [5] KEYWORD FALLBACK                                   │
│  When the model fails, times out, or returns garbage:   │
│  • Specific patterns first (exec, task, cron)           │
│  • Broad patterns last (web_search)                     │
│  • Order matters — first match wins                     │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [6] DEFAULT → chat                                     │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [7] SECURITY FILTERING (6 layers)                      │
│  1. Channel whitelist (allowedCategories)                │
│  2. Owner-only tools (code gate — invisible to others)  │
│  3. Restricted categories (untrusted users blocked)     │
│  4. Blocked tools (channel-level blacklist)              │
│  5. Restricted tools (untrusted user blacklist)          │
│  6. Confirm tools (preview before execution)            │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [8] CONVERSATIONAL GUARD                               │
│  Prevents pipeline misroutes mid-conversation:          │
│  "What do you think about performance?" ≠ research      │
│  Only explicit task intent breaks through the guard     │
│  Skipped for console/extension (browser control needs   │
│  the router's classification to stick)                  │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [9] DISPATCH DECISION                                  │
│  • No tools → bare chat (direct LLM, no loop)           │
│  • Has pipeline → deterministic stages                  │
│  • Category is 'multi' → plan decomposition             │
│  • Otherwise → ReAct tool loop                          │
└───────────────────────┬─────────────────────────────────┘
                        ▼
                  Specialist Execution
```

---

## Layer 1: File Type Routing

Before the message hits the router, attachments are pre-processed. The file extension determines the path — no model involved.

```
attachment → check extension
  → image (.png, .jpg, .gif, .webp)     → vision describes it → chat
  → PDF (.pdf)                           → extract text → inject → route normally
  → data (.csv, .xlsx, .json, .tsv)      → analytics pipeline (auto)
  → text (.md, .txt, .html, .log)        → ask user: knowledge base or read as text?
  → unknown                              → ask user same choice
```

The analytics override is the strongest example of code-driven routing. A CSV upload will always go to the analytics pipeline. The model never decides — the file extension does.

---

## Layer 2: Pre-Model Overrides

High-confidence patterns that the router model gets wrong often enough to warrant a code override. These fire before any LLM call.

| Pattern | Routes To | Why It Exists |
|---------|-----------|---------------|
| Message contains a URL | `website` | Model classified bare URLs as `web_search` (searched for the URL instead of fetching it) |
| Email/calendar + time words | `personal` | Model classified "check my calendar" as `chat` |
| "Make a PDF report" | `research` | Model classified report generation as `multi` or `chat` |
| "Go to [site]" + domain | `multi` | Model didn't recognize browser navigation intent |
| "Research/analyze" + "stock/market/trend" | `research` | Model classified research requests as `web_search` |

**The principle:** Pre-model overrides only exist for patterns where the model has proven unreliable. Every override was added because of a real misclassification observed in production. We don't override everything — just the cases with a documented history of failure.

---

## Layer 3: Sticky Routing

Multi-turn conversations should stay in the same category. If you're chatting about cooking and ask "what about chicken?", that should stay in `chat`, not route to `web_search` because the model sees a question.

**How it works:**
- Only `chat` and `memory` categories are sticky. Pipeline categories (web_search, exec, research) finish in one turn — no sticking needed.
- Short follow-up messages stay on the previous category.
- Long messages (>200 chars) also stay sticky — they're likely continuing a discussion.

**What breaks through sticky:**
- Imperative commands: "search for X", "create a report", "run this command"
- Greetings: "hi", "hey", "hello" — starts fresh classification
- New-topic signals: "search the web for", "look up", "find me a"
- Keyword matches that point to a different category than the current one

**Why sticky exists:** Without it, every message mid-conversation gets re-classified independently. "What do you think about the trade-offs?" during an AI discussion gets classified as `research` because "trade-offs" sounds analytical. Sticky keeps the conversation flowing.

---

## Layer 4: Model Classification

If pre-overrides and sticky routing don't apply, the router model classifies the message.

**Model:** phi4:14b
**Temperature:** 0.1 (very low — same message should always produce the same category)
**Output:** Single word — just the category name
**Latency:** ~50ms

The prompt is intentionally minimal. It lists the 15 categories with one-line descriptions and asks for exactly one word back. The model doesn't see conversation history, tools, or system context — just the message and the category list.

**Why phi4:14b:** Fast classification at 200 tokens per decision. Few-shot capable — understands category descriptions. Dense model — no thinking overhead. The router doesn't need reasoning, it needs pattern matching at scale.

**15 categories:**

| Category | What It Handles |
|----------|----------------|
| `chat` | Conversation, opinions, questions answerable from context |
| `web_search` | Questions needing current internet information |
| `memory` | Questions about past conversations or stored facts |
| `exec` | Shell commands, file operations, system administration |
| `cron` | Schedule, list, or manage recurring tasks |
| `message` | Send messages to other channels/users |
| `website` | URL fetching and summarization |
| `multi` | Complex requests needing multiple tools or browser automation |
| `config` | Self-administration — edit cron jobs, workspace files |
| `task` | Create, list, update, or complete tasks |
| `research` | Deep research, report/deck generation |
| `personal` | Email, calendar, schedule queries (owner-only) |
| `image` | Image generation |
| `code_gen` | Code project generation via OpenCode |
| `analytics` | Data file analysis (CSV, Excel, JSON) |

---

## Layer 5: Keyword Fallback

When the model fails, times out, or returns an invalid category, regex patterns take over.

**Order matters.** Specific patterns match before broad ones. This prevents "search for docker commands" from routing to `web_search` instead of `exec`.

```
Priority order (first match wins):
  1. Document formats (pdf, xlsx) → multi
  2. Compound actions (search + save) → multi
  3. Research requests (with explicit markers) → research
  4. Browser interaction → multi
  5. Config/settings → config
  6. Heartbeat management → cron
  7. System commands (npm, git, sudo) → exec
  8. Task management (todo, kanban) → task
  9. Scheduling (remind, cron, daily) → cron
  10. Memory recall (remember, last time) → memory
  11. Messaging (send, notify) → message
  12. Search (google, look up, news) → web_search  ← broadest, last
```

**What we removed from keywords:** "what is" and "who is" used to trigger `web_search`. But "what is the meaning of life?" is a chat question. Removing these broad patterns reduced false keyword matches significantly.

---

## Layer 6: Default

If nothing matches: `chat`. The safest default — the chat specialist can handle most things conversationally, and if it can't, the silent re-route (post-dispatch) catches it.

---

## Layer 7: Security Filtering

After classification, six security gates filter what a user can do. These run in order, each narrowing permissions:

```
Layer 1: allowedCategories
  └── Channel whitelist. WhatsApp might only allow chat + web_search.
      Category not in the list → downgraded to chat.

Layer 2: ownerOnlyTools
  └── CODE GATE. Owner-only tools (exec, gmail, calendar) are completely
      invisible to non-owners. The model never sees them in the tool list.
      Not a prompt instruction — a code-level filter before the model runs.

Layer 3: restrictedCategories
  └── Untrusted users can't access these categories at all.

Layer 4: blockedTools
  └── Channel-level tool blacklist. Everyone on this channel loses these tools.

Layer 5: restrictedTools
  └── Untrusted users on this channel lose these specific tools.

Layer 6: confirmTools
  └── Preview before execution. User must confirm before the tool runs.
      "⚠️ About to run exec[rm -rf /tmp/old] — confirm?"
```

**The owner-only gate is critical.** It's not a prompt telling the model "don't use exec for non-owners." The tools are stripped from the model's vocabulary entirely. The model can't use what it can't see. You can't prompt-inject past a code gate.

---

## Layer 8: Conversational Guard

The most nuanced layer. Prevents pipeline misroutes when a user is mid-conversation.

**The problem:** You're discussing AI model architectures. You say "what do you think about the performance improvements?" The router classifies this as `research` because it sees "performance" and "improvements." Without the guard, your casual question triggers a full research pipeline with parallel searches and chart generation.

**How it works:** If the message is classified as a non-chat category but the session has prior turns and the message has no explicit task intent, downgrade to `chat`.

**What breaks through the guard:**
- Explicit task commands: "search for X", "create a report", "generate an image"
- Pre-model overrides (already classified before guard runs)
- First messages (no session history)
- Cron jobs (autonomous, no conversation context)
- Console/extension messages (browser control needs direct routing)

**What it catches:** Everything the model gets wrong mid-conversation. "Tell me more about that" classified as `message`. "Can you explain the research?" classified as `research`. "What's the latest on this?" classified as `web_search`. All correctly downgraded to `chat`.

---

## Layer 9: Dispatch Decision

The final routing — how the message gets processed:

```
┌─────────────────┐     ┌──────────────────────────────┐
│ No tools         │────▶│ Bare chat (direct LLM)       │
│ (e.g., greeting) │     │ No tool loop, just respond    │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ Has pipeline     │────▶│ Deterministic pipeline        │
│ (task, exec,     │     │ Code controls the workflow    │
│  web_search...)  │     │ LLM fills params, synthesizes │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ Category = multi │────▶│ Plan pipeline                 │
│                  │     │ LLM decomposes into sub-tasks │
│                  │     │ Code executes each step       │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ Everything else  │────▶│ ReAct tool loop               │
│ (chat, config,   │     │ Model decides what tools to   │
│  personal, image)│     │ use and in what order         │
└─────────────────┘     └──────────────────────────────┘
```

**The principle:** If the workflow is predictable (search → fetch → synthesize), use a pipeline. If the workflow depends on what the model finds (open-ended conversation, calendar queries, image generation), use ReAct.

---

## Post-Dispatch: Silent Re-Route

After the specialist produces a response, one more safety net runs.

If the chat specialist says "I don't have access to search the web" or narrates a tool call without actually executing it, the system detects the capability gap, re-classifies the message, and dispatches to the specialist that has the right tools — silently, without the user needing to rephrase.

This catches the long tail of misclassifications that none of the other layers caught. The chat specialist admits it can't help, and the system automatically finds the specialist that can.

A `_reRouted` flag prevents infinite loops — if the re-routed specialist also fails, it stops.

---

## Special Routing Modes

### Browser Control (Chrome Extension)

When the Chrome extension is connected, console channel messages get special treatment:
- Model switches to qwen3.6:35b (better reasoning for multi-step browser tasks)
- Pipeline is stripped (forced ReAct — browser control is inherently reactive)
- web_fetch tool is removed (forces the browser tool for navigation)
- Max iterations bumped to 20
- System prompt replaced with browser-specific instructions
- Conversational guard is skipped (router classification needs to stick)

### Cron Jobs

Cron jobs dispatch with an explicit category override and `cronMode: true`. Cron mode strips write tools (write_file, task_add, memory_save) so automated tasks can't modify state without human approval.

### Smart Model Routing

For trivial greetings ("hi", "thanks", "cool"), a lighter model handles the response. No need to load qwen3.6:35b for "hello." This is a latency optimization, not a routing change — the message still goes to `chat`, just with a faster model.

---

## Two Dispatch Paths

A critical architectural detail. There are two ways messages reach dispatch:

```
Discord / Telegram / WhatsApp / iMessage
  → orchestrator.handleMessage()
    → attachment pre-processing
    → resolveRoute()
    → dispatchMessage()

Web console / Chrome extension
  → POST /console/api/chat
    → chat.ts handler
    → dispatchMessage()
```

The console path handles its own attachment processing, command parsing (`!research`, `!reset`), and page context token stripping. **Routing changes added to the orchestrator do NOT affect the console path.** This has been a source of bugs — any routing override needs to exist in both places or it only works on one set of channels.

---

## Observability

Every routing decision is logged with the layer that made it:

```
[Router] Pre-model override: "https://reddit.com/..." → website
[Router] Sticky: "what about the pricing?" → chat (follow-up)
[Dispatch] Category: web_search (model)
[Dispatch] Category: analytics (override)
[Dispatch] Conversational guard: research → chat (no task intent, turn 3)
[Dispatch] Browser control mode → guided ReAct
[Dispatch] Silent re-route: chat gap detected → web_search
```

No black boxes. Every misroute is traceable to the layer that made the decision.

---

## The Numbers

- **15 categories** covering all user intents
- **~20 pre-model overrides** catching high-confidence patterns
- **~20 keyword fallback patterns** as safety net
- **6 security layers** per message
- **~50ms** for model classification
- **4 tiers of fallback:** overrides → model → keywords → default
- **3 post-classification guards:** security → conversational guard → dispatch decision

---

## Lessons Learned

**1. Pre-model overrides exist because models fail predictably.**
When you see the same misclassification 3+ times, add an override. Don't fight the model — route around it.

**2. Sticky routing prevents the most common misroute.**
Without it, every question mid-conversation gets independently classified. "What do you think?" becomes a research task.

**3. The conversational guard is the most important post-classification layer.**
It catches everything the model gets wrong mid-conversation. Explicit task intent is the only way to break through.

**4. Keyword fallback order matters.**
Specific before broad. `exec` before `web_search`. Otherwise "search for docker commands" routes wrong.

**5. Security is a code gate, not a prompt.**
The model never sees owner-only tools. You can't bypass this with prompt injection because the tools aren't in the model's vocabulary.

**6. Two dispatch paths means two places for routing logic.**
The console API bypasses the orchestrator. Every routing change needs to be applied in both places.

**7. Silent re-routing catches the long tail.**
When the chat specialist admits it can't do something, the system re-classifies and dispatches without the user needing to rephrase.

**8. Not everything needs a pipeline.**
Browser control failed as a deterministic pipeline but works as guided ReAct. If the workflow is unpredictable, let the model react. If it's predictable, use a pipeline. Don't force one pattern on everything.

---

*LocalClaw is an open-source local-model-first AI agent framework. The routing system described here handles 39 tools across 15 categories with 12 deterministic pipelines — all running on personal hardware via Ollama.*
