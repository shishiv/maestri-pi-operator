# Arquitetura do transporte Maestri para Pi e OMP

A extensão transporta chamadas tipadas entre Pi ou OMP e o CLI nativo do Maestri.
O Maestri continua responsável pelo canvas, pelas conexões, pelas permissões
e pelo ciclo de vida dos terminais. Skills, playbooks, princípios, bootstraps
e montagem automática do canvas ficam fora deste pacote.

## Entrada e execução

`src/index.ts` exige `MAESTRI_WORKSPACE_ID` e `MAESTRI_SOCKET` antes de registrar
qualquer superfície. Sem ambas, não registra tools, hooks ou comandos. Dentro do
Maestri, registra catorze tools de comunicação, roles, notas e portais, o
notificador de respostas async e o comando opt-in `/maestri-operator`. O comando
só injeta orientação quando chamado explicitamente; não há instrução de
planejamento, startup operacional ou montagem automática de equipe.

O gate controla somente recursos deste pacote. Skills globais de instalações
anteriores pertencem ao instalador que as criou; este pacote não as descobre,
ativa, remove ou migra.

A fonte permanece em TypeScript e MJS. `scripts/build.mjs` gera `dist/` limpo
com o compilador local, reescrevendo imports relativos para JavaScript. O pacote
distribui essa saída, incluindo declarações de tipos, e Pi/OMP carregam `dist/index.js`
pelo mesmo manifesto `pi.extensions`. O runner e o executável externo não dependem
do loader TypeScript do host.
`bin/mpo-extension` conserva o caminho público e carrega `dist/extension-cli.mjs`,
gerado de `src/extension-cli.mjs`. Não há transpiler adicional em runtime.

`src/canvas-tools.ts` traduz parâmetros TypeBox em comandos fixos do CLI.
Não interpreta listagens para planejar efeitos. Não gera páginas nem mantém
manifests, bindings, versões ou um journal de mutações. Cada chamada executa
um comando e devolve o resultado do Maestri.

Os schemas de parâmetros usam o import público `typebox`, que o OMP adapta
à sua fronteira de tools. Schemas internos de Recibo, lock e invocação usam
`typebox/type`, junto de `Check` de `typebox/value`: construtor e validador
permanecem da mesma implementação, sem misturar a facade do host com TypeBox
real. O peer aceita TypeBox 1.x a partir de 1.3.7. O runner continua em processo
Node separado, fora do remapeamento do OMP. Isso não muda o formato persistido.

Roles são criadas somente no workspace atual. As tools não expõem escopo
global, atribuição de roles, edição de prompts existentes ou exclusão.
Notas usam leitura numerada, criação com nome estável, edição de trecho e
organização em fichário. O Maestri recusa alterações em notas bloqueadas.
A extensão escapa barras invertidas nos textos de notas e nos prompts de roles
porque o CLI decodifica sequências de escape nesses argumentos.

`src/cli-text.ts` possui o contrato dos prompts de ask. Sync e runner async
codificam barras uma vez, na saída para o CLI. O digest continua sendo do texto
lógico original. Pedidos novos validam os 65.536 bytes após encoding e envelope
antes do preflight; recuperação de recibo existente precede essa validação de
wire format. Essa regra não é aplicada indiscriminadamente a outros comandos.

`src/maestri.ts` possui resolução do executável, ambiente mínimo, execução
sem shell, cancelamento e formatação de saída. O processo recebe um grupo
Linux próprio. Timeout ou abort envia TERM e depois KILL, com cinco segundos
de tolerância. Capturas interrompidas ou acima do limite bruto de 1 MiB são
descartadas. A resposta ao modelo é sanitizada, marcada como não confiável e
limitada a 2.000 linhas ou 50 KiB.

Falhas são lançadas como erros de tool do Pi. Uma mutação interrompida tem
conclusão desconhecida. A extensão orienta a consultar o estado atual, sem
repetir a operação. Um cancelamento anterior à execução não envia comando.

## Portais web e Android

`src/portal-tools.ts` registra duas ferramentas agrupadas. Os enums usam
`StringEnum` do SDK. `src/portal-command.ts` valida os campos de cada ação e
traduz a chamada para um único argv nativo, sem shell, automação via Wire ou
acesso direto ao ADB. Texto de fill/type escapa barras invertidas; JavaScript
e valores de select permanecem literais porque o CLI não os decodifica.

`src/portal-output.ts` usa o mesmo processo limitado de `src/maestri.ts`, com
15 segundos para web e 90 para Android. Respostas interativas diferentes do
ack nativo `ok` viram erros. Leituras estruturadas reconhecem erros textuais
conhecidos. Texto livre, HTML, logs e evaluate não são classificados pela
aparência: o CLI perde a distinção entre alguns dados e erros de execução.

Somente screenshot pode carregar um arquivo como imagem. O nome precisa ser
o PNG temporário nativo no tmpdir local, regular, do mesmo usuário e sem symlink.
A leitura é limitada a 10 MiB, valida cabeçalho e dimensões até 25 megapixels,
e conserva os bytes. Não há redaction ou resize de imagem. Cancelamento descarta
o resultado. O cleanup do PNG continua com o Maestri, sem deletar o portal.

Criação de nó não implica renderer ou dispositivo pronto. A extensão não
promete interromper um efeito remoto quando encerra o CLI local. Não há retry,
recriação, instalação de SDK ou mudança de configuração implícita.

## Pedidos async

`src/ask-async.ts` mantém o contrato de envio durável. Antes de iniciar um
pedido, exige uma captura atual de um Pi suportado e ocioso e recusa outro
pedido ativo para o mesmo agente. `src/readiness.ts` classifica somente essa
captura, sem afirmar liveness ou identidade do terminal.

No layout completo, as bordas do composer devem ter a mesma largura e não
podem ser linhas indentadas do rascunho. Uma linha de status após o footer é
permitida somente com composer vazio e diretório reconhecido. O texto do status
não comprova prontidão. Layouts desconhecidos continuam recusados.

O recibo é persistido antes do spawn. O escopo é derivado de workspace e terminal sob
`${XDG_STATE_HOME:-~/.local/state}/maestri-pi-operator/ask/scopes`.
Diretórios usam modo `0700` e arquivos `0600`. O recibo guarda somente digest e
tamanho do prompt, não seu corpo nem o environment. A captura sanitizada do
terminal é outro arquivo privado e pode repetir o prompt renderizado e a resposta
até a retenção removê-los. Registros estrangeiros ou legados sem escopo são
recusados; a normalização de registros legados deve ser estrita, sem completar
campos que não possam ser comprovados.

`src/ask-receipt.ts` valida o contrato persistido; `src/ask-store.ts` possui
transações com snapshot independente e no-op explícito. Metadados de
notificação não alteram fatos terminais nem sua versão. `src/receipt-lock.ts`
usa compare-and-swap SQLite para evitar que um reclaimer remova o sucessor;
identidade do dono do lock guarda digest de cmdline, não o texto do comando.
O esquema de coordenação é validado e o bootstrap é serializado.

A troca do protocolo JSON antigo exige quiescência dos produtores anteriores.
Markers legados causam recusa, sem limpeza automática; sua ausência não prova
que um escritor antigo foi encerrado. Não há convivência de versões dos dois
protocolos. Recibos e capturas são preservados; consulte a
[ADR de atualização](adr/0003-atualizacao-dos-locks-com-quiescencia.md).

Replay da mesma chave, agente e digest de prompt retorna o mesmo request ID.
Payload diferente conflita antes do envio. A elegibilidade de retenção considera
sete dias e os 200 pedidos em estado terminal mais recentes, prevalecendo o conjunto
menor. A limpeza ocorre oportunisticamente durante atividade, sem hard deadline
de apagamento e sem garantia de retenção mínima. Não há daemon de retenção a
pressupor; a ausência momentânea do registro não autoriza reenviar.

O processo pai conserva a custódia do pedido e o runner executa um único ask.
Somente o handshake autenticado do runner
pode avançar o pedido de accepted para running. Restart reconcilia PID, PGID,
o instante de criação em `/proc` e o cmdline completo antes de confiar ou
sinalizar o grupo. Identidade ambígua nunca autoriza um sinal ou reenvio.

O prazo de handshake também limita backpressure ao escrever o payload do runner.
Falhas de startup retêm apenas códigos de erro reconhecidos, sem tratar stderr
como resposta do peer. Status e result projetam reason, termination e exit_code
sanitizados; não alteram retrospectivamente a certeza de entrega do recibo.

Entrega e resposta são estados separados. O runner sanitiza a captura antes de
persisti-la. `src/reply-envelope.ts` isola uma resposta pelos marcadores do
request ID. Envelopes de outros pedidos fora da resposta atual são histórico,
não duplicatas. Marcadores atuais ausentes, duplicados, malformados ou
envelopes aninhados deixam reply desconhecido. Resultado pendente não expõe
texto parcial.

## Notificações e integração externa

`src/ask-notifier.ts` observa o journal do escopo e envia um follow-up quando
o chamador Pi/OMP está ocioso. O registro guarda a notificação e seu claim de processo.
O aviso inclui a orientação de ler `result` daquele pedido uma vez, sem reenvio,
para permitir a retomada mesmo em uma sessão sem briefing anterior.
Um claim estrangeiro vivo impede outro envio. A transação que arma `dispatching`
confere o dono do claim e não arma o envio se o Reconhecimento Pi já venceu essa corrida.
Antes de chamar `sendMessage`, o estado `dispatching` é persistido; se a gravação
posterior falhar, restart não reenvia um aviso cuja entrega ficou incerta.
Falha síncrona de envio volta a `pending`, libera o claim e só é reavaliada após
outro `agent_end` ou numa nova sessão. Ler result faz o ack.

O notifier usa somente `session_start`, `agent_end` e `session_shutdown`, comuns
a Pi e OMP. Como `agent_end` pode ocorrer durante busy, conserva o wake pendente
e consulta apenas `ctx.isIdle()` a cada 250 ms até poder fazer o scan: não lê o
journal enquanto o chamador está ocupado. Depois de consumir os wakes, para de
consultar. Reconfere idle após IO, coalesce eventos sobrepostos e cancela o timer
no shutdown, aguardando as gravações em andamento. Eventos de arquivo e ticks
não reabrem tentativas de envio que falharam; não há dependência de `agent_settled`.

Falhas de leitura ou gravação durante o scan em segundo plano são contidas e
geram um aviso genérico na UI ou stderr, sem conteúdo do journal. O aviso não se
repete até um scan bem-sucedido. Nenhum recibo é apagado para esconder a falha;
um evento posterior permite nova verificação, sem reenviar prompts.

O contrato canônico `mpo.ask-terminal.v1`, definido por `src/ask-terminal.ts`,
é limitado a 4 KiB e não contém texto de prompt ou resposta. `src/ask-waiter.ts` e
`src/extension-cli.mjs`, exposto por `bin/mpo-extension`, oferecem espera finita
e somente leitura, além do adapter Firstmate `maestri-ask`. O contrato de
integração exige `MAESTRI_WORKSPACE_ID` e `MAESTRI_TERMINAL_ID` no ambiente;
UUID não é capacidade cross-scope.
Eles não fazem claim, acknowledgement, cancelamento ou reenvio.

O Aviso Pi pode ser duplicado por claims, acknowledgement ou restart, mas uma
falha também pode resultar em nenhum aviso; não há garantia universal de entrega.
O Reconhecimento Pi ocorre quando o chamador lê o resultado; o acknowledgement
externo, a publicação e o re-arm pertencem ao Firstmate e não substituem essa
leitura. Pending e result são observações sem retry implícito.

## Verificação

`npm run check` exige lint sem warnings (anti-slop e complexidade máxima 10),
typecheck de TS e MJS e os testes locais. Cobre tradução para argv, texto literal, rejeições anteriores ao
efeito, limites de saída, cancelamento e os contratos de persistência async.
`npm run smoke` verifica o carregamento e chamadas nativas no Pi com CLI
controlado. O smoke ao vivo é separado e exige um terminal descartável.

`tests/installed-package.test.ts` instala o tarball, sem link ao checkout, e
exercita o executável externo, o runner, o waiter e a entrada pública. O cache npm
é vazio; somente os peers declarados são fornecidos por links explícitos para a
instalação de desenvolvimento versionada. O pacote testado não é um link para o
checkout. A criação do recibo e o CLI são controlados; isso não substitui uma jornada Pi/Maestri real usando
o mesmo pacote instalado. Os testes locais não substituem jornadas Pi/Maestri,
web ou Android reais; quando o ambiente ou as fixtures não estiverem disponíveis,
a evidência deve ser registrada como **BLOCKED**, não como PASS.

`tests/omp-validation.test.ts` usa os mesmos casos de Recibo, lock e invocação
em Node e no loader real do OMP, tanto para fonte quanto para `dist`. A parte
OMP exige Bun e `MPO_OMP_PACKAGE_ROOT`; sem esse caminho, registra skip explícito.
Os testes do notifier reproduzem busy após `agent_end`, retorno a idle sem novo
evento, shutdown, retry limitado e Reconhecimento Pi concorrente com relógio
controlado. Suporte ao host OMP não certifica OMP como destinatário de Pedido async.

Uma prova ao vivo do tarball local corrigido completou OMP 18.2.6 em RPC →
Maestri → Pi 0.85.1, ambos com Azure GPT-6 Astra. Houve um Pedido async, um Aviso
Pi nativo e uma leitura de result pelo modelo chamador. O Recibo terminou com
`delivery=confirmed`, `reply=received`, `custody=released` e `notification=acked`,
com uma tentativa de aviso. O chamador encerrou com código 0. Essa prova não
certifica OMP como destinatário nem jornadas web/Android; a evidência sanitizada
fica nos artefatos locais da verificação, sem credenciais nem captura integral.

O build compila e valida em staging antes de substituir `dist`, com rollback
se a publicação falhar; não promete troca atômica sem janela para leitores.
O teste instalado compila um consumidor TypeScript e verifica handshake e
operações Firstmate pelo executável distribuído. Os testes do harness de smoke
usam Pi controlado sem modelo; o smoke model-backed mantém eventos, argv e a
primeira falha em `.artifacts/smoke-v01/`.

O pacote não possui autoridade sobre backlog, branches, worktrees ou entrega de trabalho.
O conteúdo dos papéis é fornecido pelo chamador, não por este pacote.
