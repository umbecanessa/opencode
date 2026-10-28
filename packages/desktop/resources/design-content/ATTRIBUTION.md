Design content bundled with OpenCode Desktop

Skills, design templates, craft references and brand kits ported from
nexu-io/open-design (Apache-2.0, https://github.com/nexu-io/open-design) at
commit d297055. Individual LICENSE / LICENSE.txt files inside skill directories
are preserved and take precedence for those directories. `od:` frontmatter
blocks (OpenDesign registry metadata) were removed; content is otherwise
unchanged.

- skills/*            -> <opencode config>/skills/*
- design-systems/*    -> <opencode config>/design-systems/* (English DESIGN.md only)
- craft/*.md          -> skills/design-craft/references/

frontend-design derives from Anthropic's official skills (upstream link in its
frontmatter). The design-lint script ports OpenDesign's artifact linter rules.
The brand-kits, design-craft, design-lint, design-critique and html-artifacts
skills are written for OpenCode and wrap the ported content.

On launch the desktop app copies these directories into the opencode config
directory when absent, and refreshes directories it previously installed
(marked with a `.opencode-bundled` file). Directories without that marker are
treated as user-owned and never modified.
