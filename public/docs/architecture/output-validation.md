# Output validation

A workflow can be given a function that checks its **own output** when a
run finishes. It is written by the AI, saved onto the workflow, and run
automatically at the end of every successful execution.

This is distinct from the change review the chat assistant performs after
a build. The review inspects the *pipeline* against the conversation,
before anything runs. Output validation inspects the *data the pipeline
produced*, after it has run.

## Turning it on

From the workflow's **Execution Steps** screen: tick "Validate workflow
output when execution completes", then generate the function. You can
also ask the chat assistant to do it ("validate the output of my X
workflow", "make sure the results look right after it runs").

Either way a focused sub-agent studies the whole pipeline read-only:
what goes in, how it is transformed, and what the output node writes. It
infers the **goal** in plain English, samples the produced tables if it
needs to confirm their shape or scale, and then writes the function. The
goal and a short explanation of what the function checks are shown to you
and saved alongside it, so you can see what will be verified.

## What the function can do

It receives the same helper surface generated code always gets — reading
any connection or local store, listing tables and columns, calling the
AI, embedding text, making HTTP requests, logging — and returns either
"valid", or invalid with a short reason.

Two things are different here:

- **AI and HTTP calls are metered.** A fixed budget per run, which the
  function can see so it can pace itself; exceeding it throws. Validation
  is meant to lean on cheap deterministic checks — row counts, null and
  range checks, column presence, referential checks — and to use the AI
  only where the question genuinely needs judgement, on a small sample.
- **It must be self-contained and defensive.** No imports; risky calls
  wrapped so a failure becomes a reason string rather than an exception.

## What a verdict means

A failing validation **never fails the run**. The execution is still
recorded as completed; the verdict is stored with it and surfaced in the
UI, and logged as a warning in the run's timeline. What the workflow
wrote, it wrote — the validation tells you whether the result looks
right, not whether the run happened.

Validation is skipped entirely for a run that was **stopped**: a run cut
short never got the chance to produce what it was meant to, so reporting
it as invalid would be noise rather than a finding.

## Drift

A validation function is written for a specific goal, and a workflow
changes. Ternlux keeps a signature of the workflow's structure at the
moment the function was generated: if the structure is unchanged, nothing
can have drifted and no check is needed. When it *has* changed, the model
is asked whether the current workflow still matches the goal the function
was written for — and if not, the chat says so and points you back to
Execution Steps to regenerate it.
