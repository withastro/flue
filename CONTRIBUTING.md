# Contributing to Flue

We are partly using this project to explore what the software develompent lifecycle (SDL) will look like in the future. AI coding agents are disrupting decades of cultural norms around how software is built. "Drive-by AI slop PRs" can just as easily come from an external OSS contributor or a coworker. Instead of trying to preserve the old ways, this project is a leap into one vision (made up of many experiments) of the future.

So we're going to try to reimagine things. We may be right. We may be wrong. Probably a bit of both. But the real value is that we will learn a lot along the way that can hopefully help inform how other teams structure their work and navigate these strange times.

## TLDR for Contributors

We accept the following contributions:

1. **Bug reports, fix proposal, etc:**
   - For humans: https://github.com/withastro/flue/issues
   - For agents: .github/ISSUE_TEMPLATE
2. **Feature requests, enhancements, etc:**
   - For humans: https://github.com/withastro/flue/discussions
   - For agents: .github/DISCUSSION_TEMPLATE/feature-request.yml

No other contributions are accepted at this time. Exception are rare and will be made at lead maintainers discretion.

Pull Requests will be automatically closed and converted into one of those two approved contribution types.

## Context: How Flue is Built

To understand how an AI native project should work, we decided to look to the past.

[The Surgical Team](https://wiki.c2.com/?SurgicalTeam) is a software engineering organization pattern proposed by Harlan Mills and popularized by Fred Brooks in his seminal 1975 book, [The Mythical Man-Month.](https://en.wikipedia.org/wiki/The_Mythical_Man-Month) Essentially, a lead maintainer drives the project with support from others. From Brookes:

> **Small teams vs. large systems.** Brooks observed that small teams (even as few as 2-3 people) produce dramatically better software per person than large teams, due to reduced communication overhead and conceptual coherence. But small teams can't build large systems fast enough to meet real-world deadlines.
>
> The conventional answer — add more people — runs into Brooks's Law: adding people to a late project makes it later, because communication paths grow combinatorially (n(n-1)/2). A 10-person team has 45 communication channels; a 50-person team has 1,225.
>
> Mills's insight was to reorganize so that one person does the creative work (the "surgeon") while a support team multiplies their effectiveness without multiplying the communication burden. The surgeon makes all design decisions, keeping conceptual integrity intact, while specialists (editor, administrator, toolsmith, tester, language lawyer, etc.) handle everything else.

In a world of AI agents that can write and review code while we sleep, this is more relevant than ever. The new bottleneck (for now at least) is:

1. deciding what to build next
2. deciding how to build it

For everything else (design, research, implementation, review) we've found agents are now good enough to either own outright, or to drive them with assistance and guidance from a maintainer.

This is why communication overhead is top of mind again in 2026. When good decision making becomes the critical bottleneck for your project, it becomes essential to optimize. Fewer people will make decisions faster than a traditional software team. The risk of making wrong decisions is mitigated by also maximizing the responsibility placed on the lead (just like medical surgery).

This is also why we ask contributors for issues and discussions instead of pull requests. Both are inputs that help us decide what to work on next. We can combine those inputs with our existing context as domain experts, plus the best available SOTA LLMs that we have access to. Starting from the problem gives us more room to correctly guide the agent during research, design, implementation, and initial review. Reviewing an existing PR (even an amazing one) blocks us from that essential work.

## Sustainability & Growth

Quoting from [the C2 wiki](https://wiki.c2.com/?SurgicalTeam):

> In software terms, this means you have a lead who runs the project, makes the critical decisions and to BeInCharge. A co-lead is present as a hedge against the loss of the lead (see TruckNumber) and who is there to help with design but not control. The rest of the teams role is, in essence, to let him (or her!) do that job. The junior developers are involved in the process - so they can see how analysis becomes design becomes code, but the complex code will be written by the lead. There will be other specialists - tool builders, technical authors and so on to remove workload from the lead and allow them to concentrate on the major problem at hand.

We worry about how we will train up the next generation of engineers. We worry about our own mental health, and burnout, and AI psychosis. This organizational system isn't a silver bullet for either, but it does show promise:

- Direct training and knowledge transfer between a "lead" (senior) and "co-lead" (junior).
- We are social animals and not designed to toil away in isolation, even with an LLM to help.
- The cost of a single communication path is extremely low: `(n(n-1)/2) -> (2(2-1)/2) -> 1`.
- The value in having someone to "bounce ideas off of" is extremely high.
- Bus factor.

Here, “junior” is relative to experience with the project and the problem being solved, not overall career seniority. But it also creates a clear path for someone with less experience in a particular area to get hands-on experience, seeing how those decisions become code, and gradually taking on more responsibility as they grow. This could be a model to help train the next generation of software engineers.

Flue does not have a formal co-lead today. We are still figuring out how to identify that person, how the role should work, and whether one co-lead is even the right model across every area of the project. For now, this describes the organization we are working toward rather than one we have already solved.

This is the experiment behind how Flue is built: keep the team responsible for decisions small, use agents to increase what that team can execute, and make it easy for everyone else to contribute the information that guides those decisions.
