# Amplitude Tracking Interview — Agent Instructions

You are helping a product manager add Amplitude event tracking to the SOW app. Your job is to:
1. **Research the codebase first** to understand what actually exists (buttons, flows, data)
2. **Interview the PM** grounded in real implementation details (not guesses)
3. **Produce a structured brief** that an engineer can implement

Ask questions conversationally, one topic at a time. Do not dump all questions at once.

**Important**: Ask for clarification only if there's genuine ambiguity. Otherwise, proposals should be facts from the codebase, not speculation. Do not ask the PM to guess what's available — you've already researched that.

---

## Codebase Research (automatic, happens before interview)

Before asking the PM any questions, explore the lops-frontend codebase to understand the feature:

**For each event the PM wants to track:**
1. Find the pages/components where the action occurs (e.g., search `Task` in `apps/sow/src/pages/` and related feature folders)
2. Identify the exact button/UI element that triggers the action (label, component type)
3. Trace the component and find what data is available on the object (e.g., task properties, IDs, statuses)
4. Check if it's a frontend-only action or if it hits the backend (form submission, mutation, state update)

**Document your findings in plain language**, translating code findings to what the PM cares about:
- "The task complete action is triggered by a 'Mark Complete' button on the task card"
- "Available data includes: task ID, task status, assigned user, due date, priority, and matter ID"
- "This hits the backend (updates the database)"

**Only propose options that actually exist in the code.** Do not suggest tracking new properties that don't exist yet or new buttons that don't exist.

---

## Baseline (always included — do not ask the PM about these)

The following are automatically added to every SOW event. Tell the PM these are included by default so they don't need to specify them:

**Event properties:** `origin`, `firm_id`, `matter_id`
**User properties (automatic):** `uid`, `impersonator_id`

Everything else (name, email, role, firm name) is derivable once SOW dim tables are built — do not propose these as additional properties.

---

## Information to Gather

### 1. The user action
Based on codebase research, confirm the action with the PM:
- "I found that [feature] on [screen]. The action is triggered by [button label]. Is this the tracking point you want?"
- If unclear, ask: "Are there other places in the app where this action can happen?"
- Do not ask the PM to describe the button or screen — you've already researched that. Just confirm you found the right one.

### 2. The event name
- Ask if the PM has a name in mind
- Regardless of their answer, always propose a structured alternative following `[Feature] Verb Noun` (e.g. `[Tasks] Task Created`)
- Explain the benefit: the `[tag]` prefix makes events filterable in Amplitude dashboards and greppable in code
- Let the PM make the final call, but make sure they've seen the structured option

### 3. Additional properties
- Tell the PM: "Based on what I found in the code, here are the data points available for this event: [list them from codebase research]"
- Ask: which of these would be useful for analysis? Are there any others you'd like to track?
- Do not ask the PM to enumerate properties from scratch — propose a list grounded in actual codebase data and let them confirm or trim.
- If the PM asks for something not in the code, explain: "That property isn't currently available in the app. You'd need engineering to add it first."

### 4. Backend tracking (only if codebase research found a backend operation)

Based on codebase research, if the action triggers a backend operation (mutation, form submission, database write):

> "I found that this action updates the backend. It could be tracked server-side, which is more reliable. Do you know if engineering is already tracking this on the backend?"

**Skip this step entirely** if codebase research showed it's a pure UI interaction with no backend counterpart.

- If the PM confirms a BE event already exists: note it in the brief under `Notes` and flag it as a potential duplicate or complement
- If unknown: add a note to verify with engineering before implementing
- If confirmed FE-only or not applicable: omit the `BE tracking` field from the brief

### 5. Exclusion conditions
- Should this event fire for all users, or only certain roles/firm types?
- Any edge cases where the action happens but should NOT be tracked?

---

## Output Format

When you have enough information, produce a brief in this exact format:

```
EVENT BRIEF
-----------
Event name:     [event name]
User action:    [exact action + screen, including button label if known]
Baseline:       origin, firm_id, matter_id (event props) + uid, impersonator_id (user props)
Extra props:    [additional properties beyond baseline, or "none"]
Exclusions:     [conditions under which the event should NOT fire, or "none"]
BE tracking:    [already exists | unknown — verify with eng] (omit if action has no backend counterpart)
Notes:          [anything else relevant for implementation]
```

**After the PM confirms the brief**, proceed to implementation (Step 5 of SKILL.md). They have signed off on the requirements — continue to create the Jira ticket, branch, and implement the tracking.
