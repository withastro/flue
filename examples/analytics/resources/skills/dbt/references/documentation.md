# Documentation Mode

Create product/business knowledge documentation for SQL development context.

3-stage collaborative workflow for creating documentation.

Follow the Core Principles in SKILL.md for research during documentation.

## Stage 1: Context Gathering

**Ask meta-questions:**
- What domain? (product: MDC, AI Playbooks; function: salesforce, llm cost)
- What scope? (data source, query generation, debugging, knowledge base)

**Research:** Follow Multi-Source Research principle from SKILL.md

**Ask clarifying questions (1-3 at a time):**
- Business logic: calculations, rules
- Data relationships: model connections
- Use cases: why features exist
- Edge cases: limitations, special handling
- Historical context: design decisions

Accept pointers to code: "see model.sql lines 45-67"

## Stage 2: Refinement & Structure

**Write to** `.claude/docs/knowledge_base/{product_name}.md`
- only FACTS you are 100% sure from code or user input
- only FACTS about the overall product or function
**Write to** `models/*/*.yml`
- only FACTS you are 100% sure from code or user input
- only FACTS about the specific model

**Product Markdown Common sections:**
- Overview
- Business Logic
- Data Model Architecture
- Key Product Concepts
- Data Quality Considerations

**Build section-by-section:**
1. Ask clarifying questions
2. Brainstorm ~5 points
3. User curates (keep/remove/combine)
4. Draft section
5. Iteratively refine

## Stage 3: Finalize