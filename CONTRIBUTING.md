# Contributing to ChainPay

**Start with [local development](docs/getting-started/local-development.md).**
The [product scope](docs/scope.md) defines what belongs in this project.

## Before editing

1. Check your branch and working tree with `git status` and `git remote -v`.
2. Read the affected component's README and its current tests.
3. Make one focused change. Include documentation when behavior or setup changes.
4. Run the relevant checks in [AGENTS.md](AGENTS.md#setup-and-checks).
5. Describe the user-visible result, validation, and remaining limitations in the PR.

## Fork and upstream

[stawuah/chainpay-mcp-sdk](https://github.com/stawuah/chainpay-mcp-sdk) is the
upstream product. [tantshirt/chainpay-mcp-sdk](https://github.com/tantshirt/chainpay-mcp-sdk)
is Dre's integration fork. Its PRs may be stacked: a branch can depend on
another unmerged branch.

For a change on the fork's stack, target the immediate parent branch in the
fork so reviewers see only your change. An upstream PR targets Kwasi's
repository once its dependencies are available there. Check the actual PR
base before publishing; do not include unrelated stack commits accidentally.

Workspace tooling, BMAD planning files, and Design Council artifacts are not
part of the product repository or its PRs.

## Documentation changes

Keep the README focused on understanding and first use. Put procedures in
guides and implementation detail in reference pages. Update relative links
after moving documents. See [documentation maintenance](docs/project/documentation.md).

Use real product captures with alt text. Label fixture data and distinguish
implemented behavior from a verified deployment. Preserve the original
Connection logo; do not redraw it or imitate it with text.

## Reporting problems

Include the branch or commit, component, failing command or user step, and
sanitized error. Never include session tokens, database URLs containing
passwords, provider secrets, or wallet key material.

A docs or code contribution is not authorization to broadcast a payment.
Keep live acceptance separate from regression testing.
