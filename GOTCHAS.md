# Gotchas — maestri-pi-operator

Conhecimento durável desta linha de trabalho. Cada item custou uma investigação
real; nenhum é hipótese.

## Git e publicação

- **`main` local é histórico e não é a linha pública.** A linha real é
  `publish/main`, que rastreia `origin/main`. Mesclar em `main` mistura
  histórias sem relação. Confirme com `git merge-base --is-ancestor origin/main <alvo>`.
- **`npm publish` empacota a árvore de trabalho, não o commit.** A 0.3.1 foi
  publicada de uma árvore suja e o tarball continha `dist/portal-tools.js` cujo
  fonte não existia em commit nenhum: irreprodutível e sem rollback. Commite e
  taggeie antes de `npm pack`, depois confira que o `dist` do tarball é
  idêntico ao testado.
- **Fixtures de captura de terminal têm espaço à direita significativo.**
  `git diff --check` acusa trailing whitespace nelas. É falso positivo:
  limpar corrompe a fixture e quebra a âncora SHA-256.

## Readiness e transporte

- **Autentique a superfície ativa antes de classificar conteúdo.** O bug do
  eval 033: `SHELL_PROMPT` era varrido na tela inteira, então duas linhas
  antigas de transcript terminando em `cat >` faziam um Pi ocioso virar
  `ambiguous` e o async ser recusado. A correção acha o composer vazio e só
  então estreita a varredura; se o composer não autentica, volta à tela inteira
  e falha fechada.
- **A allowlist de modelos é fixa por decisão, não por esquecimento.** Modelo
  novo exige release e prova de layout capturado. Já quebrou duas vezes:
  `gpt-5.6-luna|terra|sol` na 0.3.2 e `claude-opus-5` na 0.3.3.
- **Custódia async:** timeout ou entrega desconhecida nunca justificam reenvio.
  Reuse o mesmo `client_request_id` e leia o estado. Recusa por topologia ou
  por preflight não é evidência sobre o produto.
- **`maestri_ask_async` roda preflight de readiness; `maestri ask` síncrono
  não.** Quando o preflight instalado tem bug, o síncrono é a saída.

## API do Pi

- **O padrão de `sendMessage` é `deliverAs: "steer"`,** que entrega no meio
  do turno em curso, antes da próxima chamada ao LLM. Sempre explicite:
  `nextTurn` para orientação sem operar, `followUp` + `triggerTurn` para
  tarefa. `triggerTurn` só dispara se o agente estiver ocioso.
- **`sendUserMessage` se apresenta como fala do usuário e sempre dispara
  turno.** Não use para contexto de extensão.
- **`.oxlintrc.json` rejeita chaves desconhecidas.** Não dá para colocar
  `"//comentario"` no JSON de config.

## Maestri canvas

- **Maestro enxerga a árvore inteira, mas só muta conexões diretas.**
  `recruit --replace` e `connect` falham com `No connection` sobre o
  recruta de um recruta. Delegue a quem tem a corda, ou peça ao usuário para
  cabear no canvas.
- **Skills empacotadas perdem para as cópias globais por precedência.** O Pi
  imprime `✓ auto (user) ...` e `✗ ...(skipped)` no boot. Não é ambiguidade
  de catálogo, e o gate do pacote não alcança a cópia global.
- **`maestri ask` em background morre junto com a sessão de shell que o
  iniciou.** O prompt chega e o agente trabalha, mas o log fica vazio: leia o
  resultado no terminal do agente.

## Lint

- **O ratchet anti-slop agora é integral:** as quinze regras ficam em `error`,
  complexidade máxima é 10 e warnings falham o lint. A dívida histórica da
  0.3.3 foi zerada; não rebaixe severidade nem crie uma segunda configuração.
