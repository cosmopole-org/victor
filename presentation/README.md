# Victor — presentation

`Victor-App-Framework.pptx` is an 18-slide academic presentation of the
**Victor** app framework and its prompt-defined programming language:

1. Motivation — decoupling behaviour from syntax, interface and platform
2. The programming model — modules, behaviour prompts, I/O contracts, entrypoint
3. The syntax-free language — structured natural-language steps
4. Compilation — classification into nine operation families, template AST
   population, stack-based instruction assembly, Elpian bytecode
5. The Elpian VM — no-JIT, capability-governed execution substrate
6. Interface abstraction — the `view` / `actor` element tree
7. Multi-modal builds — CLI, voice, GUI, AR/VR, 3D and module-to-module targets
8. Implementation status, the VICTOR: CITY STRIKE case study, related work,
   roadmap and conclusions

## Rebuilding

The deck is generated deterministically from `build_presentation.py`:

```sh
pip install python-pptx
python3 build_presentation.py   # writes Victor-App-Framework.pptx
```
