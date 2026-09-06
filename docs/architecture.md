# Arquitetura do transporte Maestri para Pi

A extensão transporta chamadas tipadas entre Pi e o CLI nativo do Maestri.
O Maestri continua responsável pelo canvas, pelas conexões, pelas permissões
e pelo ciclo de vida dos terminais. Skills, playbooks, princípios, bootstraps
e montagem automática do canvas ficam fora deste pacote.

## Entrada e execução

`src/index.ts` exige `MAESTRI_WORKSPACE_ID` e `MAESTRI_SOCKET` antes de registrar
qualquer superfície. Sem ambas, não registra tools, hooks ou skills. Dentro do
Maestri, registra catorze tools de comunicação, roles, notas e portais, além do
notificador de respostas async. Também fornece seis skills operacionais por
`resources_discover`; elas ficam em `resources/skills`, fora da descoberta
estática do pacote. Não injeta instruções de planejamento no startup.

O gate controla somente recursos deste pacote. Cópias das mesmas skills gravadas
por versões anteriores do aplicativo nos diretórios globais do agente precisam
ser retiradas pelo instalador que as criou; a API de extensão do Pi não remove
skills descobertas de outras origens.

A fonte permanece em TypeScript e MJS. `scripts/build.mjs` gera `dist/` limpo
com o compilador local, reescrevendo imports relativos para JavaScript. O pacote
distribui essa saída, incluindo declarações de tipos, e o Pi carrega `dist/index.js`.
O runner e o executável externo não dependem do loader TypeScript do Pi.
`bin/mpo-extension` conserva o caminho público e carrega `dist/extension-cli.mjs`,
gerado de `src/extension-cli.mjs`. Não há transpiler adicional em runtime.

`src/canvas-tools.ts` traduz parâmetros TypeBox em comandos fixos do CLI.
Não interpreta listagens para planejar efeitos. Não gera páginas nem mantém
manifests, bindings, versões ou um journal de mutações. Cada chamada executa
um comando e devolve o resultado do Maestri.

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

`src/ask-store.ts` persiste o recibo antes do spawn. O escopo é derivado de
workspace e terminal sob
`${XDG_STATE_HOME:-~/.local/state}/maestri-pi-operator/ask/scopes`.
Diretórios usam modo `0700` e arquivos `0600`. O recibo guarda somente digest e
tamanho do prompt, não seu corpo nem o environment. A captura sanitizada do
terminal é outro arquivo privado e pode repetir o prompt renderizado e a resposta
até a retenção removê-los. Registros estrangeiros ou legados sem escopo são recusados.

Replay da mesma chave, agente e digest de prompt retorna o mesmo request ID.
Payload diferente conflita antes do envio. A garantia termina com a retenção
do registro: sete dias e os 200 terminais mais recentes, prevalecendo o
conjunto menor.

`src/ask-runner.mjs` executa um único ask. Somente seu handshake autenticado
pode avançar o pedido de accepted para running. Restart reconcilia PID, PGID,
o instante de criação em `/proc` e o cmdline completo antes de confiar ou
sinalizar o grupo. Identidade ambígua nunca autoriza um sinal ou reenvio.

O prazo de handshake também limita backpressure ao escrever o payload do runner.
Falhas de startup retêm apenas códigos de erro reconhecidos, sem tratar stderr
como resposta do peer. Status e result projetam reason, termination e exit_code
sanitizados; não alteram retrospectivamente a certeza de entrega do recibo.

Delivery e reply são estados separados. O runner sanitiza a captura antes de
persisti-la. `src/reply-envelope.ts` isola uma resposta pelos marcadores do
request ID. Envelopes de outros pedidos fora da resposta atual são histórico,
não duplicatas. Marcadores atuais ausentes, duplicados, malformados ou
envelopes aninhados deixam reply desconhecido. Resultado pendente não expõe
texto parcial.

## Notificações e integração externa

`src/ask-notifier.ts` observa o journal do escopo e envia um follow-up quando
Pi está ocioso. O registro guarda a notificação e seu claim de processo.
O aviso inclui a orientação de ler `result` daquele pedido uma vez, sem reenvio,
para permitir a retomada mesmo em uma sessão sem briefing anterior.
Um claim estrangeiro vivo impede outro envio. Restart pode repetir uma
notificação não reconhecida uma vez por sessão. Ler result faz o ack.

O notifier reavalia também em `agent_settled`, porque `agent_end` pode ainda
ocorrer durante busy. Reconfere idle após IO, coalesce eventos sobrepostos e
aguarda gravações em andamento no shutdown. Não há polling contínuo do modelo.

Falhas de leitura ou gravação durante o scan em segundo plano são contidas e
geram um aviso genérico na UI ou stderr, sem conteúdo do journal. O aviso não se
repete até um scan bem-sucedido. Nenhum recibo é apagado para esconder a falha;
um evento posterior permite nova verificação, sem reenviar prompts.

`src/ask-terminal.ts` define o envelope canônico `mpo.ask-terminal.v1`,
limitado a 4 KiB e sem texto de prompt ou resposta. `src/ask-waiter.ts` e
`src/extension-cli.mjs`, exposto por `bin/mpo-extension`, oferecem espera finita
e somente leitura, além do adapter
Firstmate `maestri-ask`. Eles não fazem claim, ack, cancelamento ou reenvio.
Captura, publicação, acknowledgement e re-arm externos pertencem ao Firstmate.

## Verificação

`npm run check` cobre tradução para argv, texto literal, rejeições anteriores
ao efeito, limites de saída, cancelamento e os contratos de persistência async.
`npm run smoke` verifica o carregamento e chamadas nativas no Pi com CLI
controlado. O smoke ao vivo é separado e exige um terminal descartável.

`tests/installed-package.test.ts` instala o tarball, sem link ao checkout, e
exercita o executável externo, o runner, o waiter e a entrada pública. O cache npm
é vazio; somente os peers declarados são fornecidos por links explícitos para a
instalação de desenvolvimento versionada. O pacote testado não é um link para o
checkout. A criação do recibo e o CLI são controlados; isso não substitui uma jornada Pi/Maestri real usando
o mesmo pacote instalado. Os testes determinísticos não exigem modelo pago.

O pacote não possui autoridade sobre backlog, branches, worktrees ou entrega.
O conteúdo dos papéis é fornecido pelo chamador, não por este pacote.
