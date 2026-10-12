# DESIGN.md — sistema visual do NCLI

Fonte de verdade da UI. Agente ou humano mexendo em `public/` ou `views/`: leia antes, use só estes tokens e rode `tools/contrast.py` quando criar um par de cor novo.

## Princípios
1. **O texto é a interface.** Um chat se lê, não se decora. Tipografia, espaço e contraste vêm antes de qualquer enfeite.
2. **Uma cor quer dizer uma coisa.** Acento azul = interativo / precisa de você / foco. Verde, amarelo e vermelho = estado. Harness = só o anel do avatar. Se não tem significado, é cinza.
3. **Hierarquia por peso e tom, não por tamanho.** `fg → fg-2 → fg-3`. Sete tamanhos de fonte e nenhum outro.
4. **Concluído fica mais quieto.** Spark resolvido, finding fechado e trace de tool descem um tom (`fg-3`). Só o que pede ação sobe.
5. **Nunca rolar contra a vontade.** O streaming cresce só pra baixo, a leitura não pula quando o bloco fecha, e "↓ agora" aparece só quando faz falta.
6. **Motion explica, não enfeita.** `transform`/`opacity`, a saída mais rápida que a entrada, e tudo some com `prefers-reduced-motion`.
7. **Antes de adicionar, pergunte se precisa.** Nada de ilustração no empty state, modal pra confirmar ação reversível ou badge redundante.

## Tokens
```css
:root {
  color-scheme: dark;
  --font-sans: "InterVariable","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  --font-mono: "JetBrains Mono",ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
  --font-features: "cv11","ss03","calt";

  /* tamanho / line-height / tracking */
  --text-xs: 11px;   --lh-xs: 16px;   --tr-xs: .01em;     /* só badge numérico */
  --text-sm: 12px;   --lh-sm: 16px;   --tr-sm: 0;         /* meta, chips, labels */
  --text-md: 13px;   --lh-md: 20px;   --tr-md: -.003em;   /* UI, nome, seat */
  --text-base: 15px; --lh-base: 24px; --tr-base: -.009em; /* mensagens */
  --text-lg: 17px;   --lh-lg: 26px;   --tr-lg: -.012em;   /* headings no markdown */
  --text-xl: 20px;   --lh-xl: 28px;   --tr-xl: -.017em;   /* título de review/spark */
  --text-2xl: 26px;  --lh-2xl: 32px;  --tr-2xl: -.021em;  /* empty state */
  --text-code: 13px; --lh-code: 20px;

  /* neutros */
  --gray-1:#0f0f11; --gray-2:#151518; --gray-3:#1b1b1f; --gray-4:#232328;
  --gray-5:#2b2b31; --gray-6:#36363d; --gray-7:#4a4a53; --gray-8:#6b6b75;
  --gray-9:#8e8e99; --gray-10:#a8a8b3; --gray-11:#c9c9d1; --gray-12:#eeeef0;
  --bg:var(--gray-1); --surface:var(--gray-2); --raised:var(--gray-3); --hover:var(--gray-4);
  --border:var(--gray-5); --border-strong:var(--gray-6);
  --fg:var(--gray-12); --fg-2:var(--gray-11); --fg-3:var(--gray-10); --fg-4:var(--gray-9); --decor:var(--gray-8);

  /* acento único + semânticos */
  --accent:#6ea4ff; --accent-hover:#8db8ff; --on-accent:#0f0f11; --accent-bg:#1a212e;
  --success:#4cc38a; --success-bg:#162520;
  --warning:#e8b54a; --warning-bg:#292318;
  --danger:#f2777a;  --danger-bg:#2a1b1e;
  --diff-add-bg:#182822; --diff-del-bg:#2f1e20;
  --h-claude:#d97757; --h-codex:#b8b8c2; --h-cursor:#9d8cf2;
  --code-bg:#131316; --syn-kw:#c4a7ff; --syn-str:#8fd6a8; --syn-num:#f0b37a; --syn-fn:#8db8ff; --syn-com:#8e8e99;

  /* espaço, raio, elevação */
  --s-1:2px; --s-2:4px; --s-3:6px; --s-4:8px; --s-5:12px; --s-6:16px;
  --s-7:20px; --s-8:24px; --s-9:32px; --s-10:40px; --s-11:48px; --s-12:64px;
  --col:720px; --msg-gap:var(--s-7); --msg-gap-tight:var(--s-3);
  --r-xs:4px; --r-sm:6px; --r-md:10px; --r-lg:14px; --r-xl:20px; --r-full:999px;
  --shadow-float: inset 0 1px 0 rgb(255 255 255/.04), 0 12px 32px -8px rgb(0 0 0/.6);
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);

  /* motion */
  --ease-out:cubic-bezier(.23,1,.32,1); --ease-in:cubic-bezier(.55,0,1,.45);
  --ease-in-out:cubic-bezier(.77,0,.175,1); --ease-drawer:cubic-bezier(.32,.72,0,1);
  --d-instant:80ms; --d-press:120ms; --d-fast:160ms; --d-chunk:140ms; --d-toast:200ms;
  --d-msg:220ms; --d-modal:240ms; --d-sheet:300ms; --d-sheet-out:200ms; --d-shimmer:1600ms;
}
@media (prefers-reduced-motion: reduce) {
  :root { --d-press:0ms; --d-msg:0ms; --d-chunk:0ms; --d-toast:120ms; --d-modal:120ms; --d-sheet:120ms; --d-sheet-out:80ms; }
}
```
A sans é `public/fonts/InterVariable.woff2`. A mono é `public/fonts/JetBrainsMono-Regular.woff2`. As duas são self-hosted, `font-display: swap`, com `<link rel="preload">`.

## Regras de uso
**Texto**
- Mensagem: `--text-base` / `--fg`. Nome do agente: `--text-md` 600 `--fg` (nunca colorido). Hora: `--text-sm` `--fg-3` tabular.
- Seat (Codex/Cursor consultados): `--text-md` `--fg-2`, avatar de 24px, `--msg-gap-tight` entre eles.
- Rótulo de seção: `--text-sm` 500 `--fg-3`, em sentence case. Sem caixa-alta com tracking.
- Mínimo de 12px. 11px só em badge numérico.

**Cor**
- `--accent`: link `view://`, badge do rail, pergunta pra você, tab ativa, foco, seleção. Se não for clicável nem pedir ação, não usa.
- Semântico só com estado real: success = aprovado/merge/+linhas, warning = limite/fallback, danger = erro/−linhas/finding alto.
- Fundo de estado = `*-bg` (12%). O texto dentro dele é `--fg` ou a própria cor semântica.
- Harness: só `box-shadow: inset 0 0 0 1.5px var(--h-*)` no avatar ou um dot de 6px.
- Superfícies em degraus: `bg → surface → raised → hover`. A borda separa, a sombra só aparece em coisa que flutua (composer, menu, modal).

**Componentes**
- Composer: `--surface`, borda `--border-strong`, `--r-xl`, `--shadow-float`. No foco, anel no container (`:focus-within`), nunca no `<input>`.
- Bolha do user: `--raised` + `--border`, raio `14 14 6 14`, `max-width: 72%`.
- Linha de sistema (trace, merge, limite): 13/20 `--fg-2`, `--r-md`, fundo por intenção (`surface`, `success-bg`, `warning-bg`). Sem borda lateral colorida.
- Código: `--code-bg`, `--r-md`, 13/20 mono. Inline code: `0.87em`, `--raised`, `--r-xs`.
- Tabela: só linhas horizontais, header `--fg-3` 500, `tabular-nums`.
- Todo interativo tem `:focus-visible { box-shadow: var(--focus-ring) }`.

**Motion**
| tipo | entra / sai | curva |
|---|---|---|
| hover | 80ms | ease-out |
| press `scale(.97)` | 120ms | ease-out |
| mensagem nova `opacity + translateY(4px)` | 220ms | ease-out |
| chunk de streaming `opacity .35→1` (sem translate) | 140ms | ease-out |
| menu/popover | 160 / 120ms | ease-out / ease-in |
| chip/toast (fila, limite, ↓ agora) | 200 / 150ms | ease-out / ease-in |
| modal / review | 240 / 160ms | ease-out / ease-in |
| sheet/painel | 300 / 200ms | ease-drawer / ease-in |
| atenção do rail `scale(1.08)` ×2 | 1200ms | ease-in-out |

## Do / Don't
| ✅ Do | ❌ Don't |
|---|---|
| `color: var(--fg-3)` | `color: #8a8a8a` (ou qualquer hex fora do `:root`) |
| Um acento pra "precisa de você" | Azul num lugar, amarelo no outro pro mesmo conceito |
| Nome do agente em `--fg` + anel no avatar | Nome em laranja e avatar quase branco |
| Card claro? Nunca. Superfície = `gray-2..4` | `background: #f5f9ff` dentro de um modal escuro |
| Animar `transform`/`opacity` | Animar `box-shadow`, `height` ou `filter` |
| Streaming a 100% de opacidade, fade só no chunk | Mensagem inteira a `.85` que acende no fim |
| `:focus-visible` com `--focus-ring` | `outline: none` sem substituto |
| Scrollbar fina no scroller | `scrollbar-width: none` global |
| Testar com nome longo, 40 mensagens e tabela larga | Validar só com o seed do demo |

## Checklist de PR de UI
- [ ] Nenhum hex novo fora do `:root` (`rg "#[0-9a-f]{3,6}" public/app.css` só no bloco de tokens).
- [ ] Par novo de texto/fundo ≥ 4.5:1 (UI ≥ 3:1), medido com `tools/contrast.py`.
- [ ] Tab passa por tudo com anel visível.
- [ ] `prefers-reduced-motion` testado (DevTools → Rendering).
- [ ] Screenshot 1440×900 de vazio, streaming, resposta longa, sparks, review e limite.
