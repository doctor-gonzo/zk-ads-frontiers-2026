# Search-my-chats prompt

Paste everything below the line into an assistant that can search your past
chats or memory (for example Claude with chat search, or ChatGPT with memory).
Save its answer under `private-data/` (ignored by git) and pass that file to
ZKAds with `--history`.

---

I'm making a playful, personalised ad about myself from my chat history. Please search our past conversations (and your memory of me, if you have any) and write a short "taste dossier" about me.

Include only harmless, public-safe material, under these headings:

1. **Obsessions**: recurring hobbies, side projects and rabbit holes
2. **Questions I keep asking**: topics I return to, with rough counts if you can tell
3. **Things I love**: tools, gadgets, foods, kinds of places, eras, books, films, games
4. **Artists and styles**: artists, designers or visual styles I've mentioned or clearly love
5. **Quirks**: running jokes and charming habits (late-night deep dives, naming things, etc.)

Leave out completely: health and medical topics, bodies and diets, money and debts, salaries, work conflicts, employer or client names, relationships and dating, family matters, sexuality, religion, politics, legal matters, names of real people, exact locations, and anything I wouldn't want posted publicly.

Format: Markdown, under 400 words. Don't invent anything; mark guesses with "(?)". If you couldn't search my history, say so at the top.
