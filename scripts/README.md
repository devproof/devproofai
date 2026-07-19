# Scripts

## smoke-serving.mjs
Regression gate for the serving foundation: port-forwards `svc/qwen05b` in
`devproof-serving` (or takes a base URL as arg) and asserts a chat completion
returns non-empty `choices[0].message.content`. Exit 0 = pass, 1 = fail.
Sub-plans B–D (operator, gateway, console) must keep this green after every task.
Run: `node scripts/smoke-serving.mjs`
