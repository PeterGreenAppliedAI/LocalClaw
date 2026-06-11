# Specialist Use Case Specs

12-point specification for each specialist. A developer should be able to read a spec and implement or debug the specialist with zero follow-up questions.

---

## chat

1. **User story:** User wants a conversational interaction — questions, opinions, discussion, greetings.
2. **In scope:** General conversation, opinion questions, follow-ups, greetings, questions answerable from memory/context, discussing topics the user is interested in.
3. **Out of scope:** Web search, file execution, scheduling, research reports, image generation, email/calendar queries. If the model can't answer, the silent re-route catches it.
4. **Data requirements:** Session history, user priming (graph memory auto-injection), workspace context (SOUL.md, IDENTITY.md).
5. **Tools:** None (bare chat) or minimal set depending on config. Chat is typically tool-free.
6. **Acceptance criteria:** Conversational, contextually aware, references memory when relevant, doesn't narrate tool calls. Responds in the user's communication style (from UserModel).
7. **Edge cases:** User asks a question that requires web search mid-conversation. Conversational guard should keep it on chat unless explicit task intent detected. Silent re-route catches capability gaps.
8. **Confidence threshold:** N/A — conversational responses are subjective.
9. **Human escalation:** When the model says "I don't have access to..." — triggers silent re-route.
10. **Known failures:** qwen3.5:9b self-prompted (replaced with gemma4:26b). Thinking tags leaking into display (fixed with stripThinking). Gemma4 docs say "no thinking in history."
11. **Pipeline:** None — bare chat (direct LLM, no tool loop).
12. **Test cases:** "hey how are you" → chat (fallback), "what do you think about local models" → chat (fallback), "what about the pricing?" with previousCategory=chat → chat (sticky).

---

## web_search

1. **User story:** User asks a question requiring current internet information — news, prices, facts, events.
2. **In scope:** Factual questions about the external world, current events, "search for X", "what's the latest on Y", price lookups, weather.
3. **Out of scope:** Questions about the user (→ memory), calendar/email (→ personal), code execution (→ exec), research reports (→ research), browsing specific URLs (→ website).
4. **Data requirements:** Web search API (Brave/Perplexity/Grok/Tavily), web_fetch for page content, browser for JS-heavy sites.
5. **Tools:** web_search, web_fetch, browser.
6. **Acceptance criteria:** Answer cites sources with URLs. Provides analysis beyond restating search snippets. Well-structured with clear sections. Answers the specific question asked.
7. **Edge cases:** "Search for docker commands" could route to exec (keyword order handles this). Ambiguous queries like "latest version" might match without search intent.
8. **Confidence threshold:** Quality review checks for source citations, structure, and completeness. Score < 3 triggers revision pass.
9. **Human escalation:** None — web search is low-risk.
10. **Known failures:** "what is" and "who is" used to trigger web_search from keywords — removed because they're questions, not search actions. Quality review sometimes suggests infrastructure changes the revision LLM takes literally.
11. **Pipeline:** web_search — extract → search → pick URLs → parallel fetch → synthesize → quality review → [revision].
12. **Test cases:** "search for the latest AI news" → web_search (keyword), "google quantum computing" → web_search (keyword), "look up the weather in NYC" → web_search (keyword).

---

## research

1. **User story:** User requests deep analysis, a report, a slide deck, or data-driven research on a topic.
2. **In scope:** "Research AAPL stock", "make me a deck on AI trends", "analyze the EV market", producing reports/decks with charts and citations.
3. **Out of scope:** Simple web searches ("what's the weather"), casual questions about a topic, browsing URLs.
4. **Data requirements:** Web search for sources, web_fetch for page content, code_session for charts (matplotlib/seaborn), write_file for deck output.
5. **Tools:** web_search, web_fetch, code_session, write_file, read_file, document, reason.
6. **Acceptance criteria:** Structured report/deck with thesis, evidence, charts, source citations with actual URLs (not homepages), actionable recommendations. Charts have titles, labels, legends.
7. **Edge cases:** "Research" mentioned casually in conversation should NOT trigger research pipeline — only explicit research requests. Pre-model override handles compound intent (research + stock/market/trend).
8. **Confidence threshold:** Quality review checks for 3+ substantive sections, source URLs cited, detail level, date accuracy.
9. **Human escalation:** None — research is read-only.
10. **Known failures:** Model fabricated data in early versions — now uses code for charts (matplotlib). Quality review once suggested "use Playwright" literally in revision. Deck HTML sometimes dumped as text if write_file fails.
11. **Pipeline:** research — plan queries → parallel search → parallel fetch → synthesize → charts → branch (deck OR report) → render → quality review → [revision].
12. **Test cases:** "research AAPL stock performance" → research (override), "make me a PDF report on AI trends" → research (override), "analyze market trends for semiconductors" → research (override).

---

## multi

1. **User story:** User requests something requiring multiple tools, browser automation, or multi-step coordination — "go to eventbrite and find events", "search and save", "make me a spreadsheet".
2. **In scope:** Compound actions (search + save), browser navigation, document generation (xlsx, pptx), multi-tool tasks that don't fit a single specialist.
3. **Out of scope:** Simple search (→ web_search), simple exec (→ exec), simple task management (→ task).
4. **Data requirements:** Full tool access — browser, web_search, web_fetch, memory, tasks, exec, document, image_generate.
5. **Tools:** All available tools for the user's trust level.
6. **Acceptance criteria:** Completes the multi-step task, produces artifacts if requested, reports what was done.
7. **Edge cases:** "Find and save" triggers multi via keyword compound. "Go to amazon.com" triggers multi via pre-model override. Browser control mode overrides to qwen3.6:35b with guided ReAct.
8. **Confidence threshold:** Plan pipeline has self-reflection stage. Skill matching reuses successful past plans.
9. **Human escalation:** Destructive tools (exec, write_file) can be in confirmTools set.
10. **Known failures:** Plan pipeline matched wrong skills (inflated success count) — fixed with threshold + ratio + cap. Browser control pipeline failed (replaced with guided ReAct). Model hallucinated actions in plan.
11. **Pipeline:** plan — LLM plan → self-reflect → execute loop (sub-dispatches) → summarize → skill save.
12. **Test cases:** "go to eventbrite.com and find events" → multi (override), "make me a spreadsheet of expenses" → multi (keyword), "find and save the best flight deals" → multi (keyword).

---

## exec

1. **User story:** User wants to run a shell command, read/write files, or perform system operations.
2. **In scope:** Shell commands (ls, git, npm, pip, sudo), file read/write, Docker operations, code execution.
3. **Out of scope:** Web search, scheduling (→ cron), task management (→ task), research.
4. **Data requirements:** Docker sandbox or command allowlist. Workspace file access.
5. **Tools:** exec, code_session, read_file, write_file.
6. **Acceptance criteria:** Command executed, output returned, errors explained. Doesn't over-explore (ls data → just ls, not find + chmod + which).
7. **Edge cases:** "read the contents of config.json" routes to config instead of exec due to keyword order (KNOWN ISSUE). Model used 8 steps for simple `ls data` in ReAct — pipeline restored.
8. **Confidence threshold:** N/A — deterministic tool execution.
9. **Human escalation:** exec tool can be in confirmTools. Cron mode strips write tools.
10. **Known failures:** ReAct loop massive over-exploration for simple commands — exec pipeline restored. Code session required action:'start' before action:'run'. Exec tool doubled workspace paths (cwd path issue).
11. **Pipeline:** exec — extract → tool → format.
12. **Test cases:** "install numpy with pip" → exec (keyword), "run npm install" → exec (keyword), "sudo apt-get update" → exec (keyword), "git status" → exec (keyword).
