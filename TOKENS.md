# Tokens propostos — NCLI (dark)

Arquivo pronto pra colar: `proposta/tokens.css`. Contraste medido: `contrast.md` (gerado por `tools/contrast.py`).

## 1. Tipografia

**Família:** Inter Variable (rsms), self-hosted. Sem CDN, porque o NCLI é local-first e pode rodar offline.
```html
<link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>
```
```css
@font-face { font-family:"InterVariable"; src:url("/fonts/InterVariable.woff2") format("woff2");
  font-weight:100 900; font-display:swap; }
--font-sans: "InterVariable","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--font-mono: "JetBrains Mono",ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
font-feature-settings: "cv11","ss03","calt";   /* a de um andar, glifos mais legíveis em UI */
```
Origem: `InterVariable.woff2` da release do github.com/rsms/inter (OFL), copiado pra `public/fonts/`. O servidor precisa servir `.woff2` com `font/woff2`. JetBrains Mono é opcional: sem ele, cai em `ui-monospace`. Números que mudam (tempo, contadores, +/−, tokens) usam `font-variant-numeric: tabular-nums`.

| token | px | line-height | peso | tracking | uso |
|---|---|---|---|---|---|
| `--text-xs` | 11 | 16 | 600 | +0.01em | **só** badge numérico e kbd |
| `--text-sm` | 12 | 16 | 400/500 | 0 | hora, chips, labels de seção, contadores |
| `--text-md` | 13 | 20 | 400/500/600 | −0.003em | nome do agente, msg de seat, rail, tabs, linhas de sistema, tabela |
| `--text-base` | **15** | **24** | 400 | −0.009em | mensagens, composer, perguntas, resumo do review |
| `--text-lg` | 17 | 26 | 600 | −0.012em | headings do markdown (h1–h3 colapsam aqui), título de card |
| `--text-xl` | 20 | 28 | 600 | −0.017em | título do review/spark |
| `--text-2xl` | 26 | 32 | 600 | −0.021em | empty state |
| `--text-code` | 13 (mono) | 20 | 400 | 0 | bloco de código, diff. Inline code = 0.87em |

Regras: nada abaixo de 12px fora de badge. Hierarquia vem de **peso e cor** (fg → fg-2 → fg-3) antes de tamanho. Sem uppercase com tracking em rótulos. `text-wrap: pretty` no corpo e `balance` em títulos.

## 2. Paleta

### Neutros (12 passos, levemente frios)
| token | hex | papel | vs gray-1 |
|---|---|---|---|
| gray-1 | `#0f0f11` | fundo do app (`--bg`) | — |
| gray-2 | `#151518` | superfície: composer, card, modal (`--surface`) | — |
| gray-3 | `#1b1b1f` | raised: bolha do user, menu, inline code (`--raised`) | — |
| gray-4 | `#232328` | hover/pressed (`--hover`) | — |
| gray-5 | `#2b2b31` | borda sutil/divisor (`--border`) | 1.36 (decorativo) |
| gray-6 | `#36363d` | borda padrão, input em repouso (`--border-strong`) | 1.6 (decorativo) |
| gray-7 | `#4a4a53` | borda em hover / composer focado | 2.18 |
| gray-8 | `#6b6b75` | decor: nº de linha, setas, ícone inativo (`--decor`) | **3.63** (UI ✓) |
| gray-9 | `#8e8e99` | placeholder, desabilitado (`--fg-4`) | **5.91** AA |
| gray-10 | `#a8a8b3` | meta: hora, labels, hints (`--fg-3`) | **8.13** AAA |
| gray-11 | `#c9c9d1` | secundário: seat, resumo (`--fg-2`) | **11.63** AAA |
| gray-12 | `#eeeef0` | texto principal (`--fg`) | **16.52** AAA |

### Acento único
| token | hex | contraste | uso |
|---|---|---|---|
| `--accent` | `#6ea4ff` | 7.67 em bg · 7.30 em surface | link, `view://`, badge, "precisa de você", tab ativa, anel de foco, seleção |
| `--accent-hover` | `#8db8ff` | 9.51 | hover de link |
| `--on-accent` | `#0f0f11` | 7.67 sobre accent | texto de badge e botão primário |
| `--accent-bg` | `#1a212e` | fg 13.93 · accent 6.47 | card de pergunta, chip "N pra você" |

### Semânticos (só pra estado, nunca decoração)
| token | texto | bg (12%) | texto/bg | quando |
|---|---|---|---|---|
| success | `#4cc38a` (8.64) | `#162520` | 7.18 | review aprovado, merge, `+linhas` |
| warning | `#e8b54a` (10.16) | `#292318` | 8.26 | limite/quota, fallback de harness |
| danger | `#f2777a` (7.02) | `#2a1b1e` | 6.04 | erro, `−linhas`, finding alto |
| info | = accent | = accent-bg | 6.47 | (fundido com o acento de propósito) |
| diff | — | add `#182822` / del `#2f1e20` | fg 13.27 / 13.65 | linhas de diff |

### Harness (discreto: anel de 1.5px no avatar e dot de 6px, **nunca** texto corrido)
| harness | hex | vs bg |
|---|---|---|
| Claude | `#d97757` | 6.13 |
| Codex | `#b8b8c2` | 9.73 |
| Cursor | `#9d8cf2` | 6.81 |

### Código
`--code-bg #131316` · kw `#c4a7ff` (9.11) · str `#8fd6a8` (10.91) · num `#f0b37a` (10.10) · fn `#8db8ff` (9.21) · comentário `#8e8e99` (5.72).

## 3. Espaço (base 4)
`--s-1 2 · --s-2 4 · --s-3 6 · --s-4 8 · --s-5 12 · --s-6 16 · --s-7 20 · --s-8 24 · --s-9 32 · --s-10 40 · --s-11 48 · --s-12 64`

| contexto | valor |
|---|---|
| coluna de leitura | 720px (`--col`), gutter 24 |
| entre turnos | 20 (`--msg-gap`) |
| mensagens seguidas do mesmo papel (seats) | 6 (`--msg-gap-tight`) |
| avatar → texto | 12 |
| nome → corpo | 2 |
| parágrafo no markdown | 12 · item de lista 4 · bloco (pre/table) 12 em cima e embaixo |
| padding de chip | 2×10 · bolha 10×14 · composer 8 / 8 / 8 / 16 · card 12×14 · modal 24×28 |
| header | 52 de altura, 16 lateral |
| dock | 16 da borda inferior + máscara degradê de 40 |

## 4. Raios
`--r-xs 4` (inline code, kbd) · `--r-sm 6` (badge, botão pequeno) · `--r-md 10` (código, tabela, linha de sistema, item de menu) · `--r-lg 14` (card, bolha, menu, pergunta) · `--r-xl 20` (modal, composer) · `--r-full` (chips, pills, avatar).
Bolha do user: `14 14 6 14`.

## 5. Motion
Curvas: `--ease-out cubic-bezier(.23,1,.32,1)` · `--ease-in cubic-bezier(.55,0,1,.45)` · `--ease-in-out cubic-bezier(.77,0,.175,1)` · `--ease-drawer cubic-bezier(.32,.72,0,1)`.

| tipo | entra | sai | curva | o que anima |
|---|---|---|---|---|
| hover (cor/fundo) | 80ms | 80ms | ease-out | `color`, `background-color`, `border-color` |
| press | 120ms | 120ms | ease-out | `transform: scale(.97)` |
| entrada de mensagem | 220ms | — | ease-out | `opacity 0→1` + `translateY(4px→0)`. Só o turno novo. Stagger 30ms em seats (máx 5) |
| streaming (chunk) | 140ms | — | ease-out | `opacity .35→1` do span novo. **Sem translate e sem animar altura**; caret 2px `--accent` 1s `steps(2)` |
| status "pensando" | 1600ms loop | — | linear | shimmer `--fg-3`↔`--fg` |
| popover/menu (agente, slash) | 160ms | 120ms | ease-out / ease-in | `opacity` + `scale(.97→1)`, origem no gatilho |
| toast/chip (fila, limite, ↓ agora) | 200ms | 150ms | ease-out / ease-in | `opacity` + `translateY(6px→0)` |
| sheet/painel (drawer, ui-pane) | 300ms | 200ms | ease-drawer / ease-in | `translateX` (painel inteiro) + `opacity` do scrim |
| modal / review fullscreen | 240ms | 160ms | ease-out / ease-in | `opacity` + `scale(.98→1)` |
| atenção (rail) | 2× 1200ms | — | ease-in-out | `transform: scale(1→1.08)` do badge. **Nunca `box-shadow`** |
| skeleton | 1600ms loop | — | linear | `background-position` |

Regras (Emil): quanto maior o elemento ou a distância, mais lento. A saída é sempre mais rápida que a entrada. Animar só `transform`/`opacity`. Blur ≤ 8px e nunca animado. Nada de motion em ação repetida por teclado (Enter, tab de review).

**`prefers-reduced-motion: reduce`:** `--d-press/--d-msg/--d-chunk = 0`. Sheet, modal e toast viram só fade ≤120ms, sem transform. Shimmer e skeleton ficam estáticos (`--raised`). O spinner vira um dot `--accent` parado. Pulso do rail desligado. Rolagem `auto` (sem smooth).
