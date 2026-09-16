# QA do transporte Maestri

Este pacote fornece transporte, não operação. Avalie as ferramentas de agentes,
notas, roles e portais, o ciclo de vida async, o notificador e o waiter. O recon do app
Maestri inteiro é outro escopo. Não restaure skills, princípios ou setup de canvas.

Estabilidade e robustez são os critérios de aceite. Latência é observação
secundária, não compensação para falha, perda de texto ou reenvio indevido.

## Camadas de prova

- `npm run check`: contratos locais e teste do tarball instalado. O build é
  automático; não usar dist antigo como evidência de uma fonte nova.
- Pacote instalado: diretório real em node_modules, sem symlink para o checkout.
  Conferir o digest do mesmo tarball usado no teste e na jornada real. O teste
  de runner com CLI controlado não certifica o loader Pi ou o app Maestri.
  O gate usa cache npm vazio e peers declarados da instalação de desenvolvimento;
  não deve depender de downloads ou de metadata guardada no cache do operador.
- Integração real: Pi/Maestri, permissões e fixtures próprias. Confirmar que o
  destinatário recebeu o Pedido antes de registrar o estado como recebido.
  Registrar ausência de Maestro/SDK/dispositivo como BLOCKED, não PASS.
- Firstmate: fornecer sempre o ambiente explícito de workspace e terminal. Um
  UUID não concede leitura fora desse escopo.

Preservar a primeira falha e seu diagnóstico. Não repetir até ficar verde,
transformar bloqueio em sucesso ou contar uma ação de portal como prova de todas.

## Instância e fixtures

- Use um terminal Maestri conectado. Confira `maestri list` e os nomes reais antes
  de enviar qualquer pedido. Guarde presença, não valores, das credenciais.
- Reutilize um Pi descartável conectado, ocioso e não selecionado para receber
  pedidos. Selecionar esse terminal pode interromper o monitoramento do Maestri.
- Use notas e roles com nomes de QA. Permissões são do Maestri: um terminal
  comum não deve acessar comandos Maestro, e uma nota sem conexão deve ser recusada.
- No fluxo atual, notas seguem diretivas append-only. Teste preservação integral
  do histórico, inclusive com final repetido. Isso é comportamento do agente:
  a API de edição continua genérica. Lock Contents é outro mecanismo e não
  exige preparação manual nesta baseline.
- Não exclua fixtures ou recursos existentes sem autorização. Registre o estado deixado.

## Baseline obrigatório

1. Descoberta, inspeção e recusa de destinatários não prontos antes do envio.
2. Ask síncrono e async com respostas exclusivas, inclusive pedidos consecutivos
   com respostas anteriores ainda visíveis na tela.
3. Resultado pendente sem conteúdo parcial e sem retry, replay pela mesma chave,
   conflito de payload e exclusão de outro pedido ativo no mesmo agente.
   Incluir recibo antigo cujo prompt excede o novo limite codificado: recuperação
   deve funcionar sem reenvio; uma nova chave deve ser recusada antes do efeito.
   Confirmar que o recibo estruturado não contém o prompt. Tratar a captura privada
   como potencial portadora do texto renderizado; não usar segredos na fixture.
4. Cancelamento, descarte de parcial e consulta posterior de pending/result sem
   reenvio implícito.
5. Encerramento do chamador enquanto o runner trabalha, recuperação do mesmo
   pedido, notificação em Pi real, reanúncio sem ack e supressão depois do ack.
   Incluir conclusão enquanto o chamador está busy, passagem a idle e consumo
   automático de result, sem exigir um novo prompt manual.
6. Isolamento por workspace e terminal. Nunca altere recibos de trabalho real
   para simular outra identidade ou crash.
7. Role list, show e create com escopo local. Note create, read com intervalos,
   edit de trecho e stack com nomes estáveis e texto literal.
8. Append-only por diretiva, recusa de trecho ausente e falta de conexão,
   sem contorno. Teste Lock Contents somente se esse mecanismo entrar no escopo.
9. Waiter com timeout silencioso e envelope terminal, sem consumir a resposta.
10. Limites, redaction, UTF-8, retenção e custódia de processos por fixtures
    isoladas nos testes existentes. Não mate processos de outros trabalhos.
11. Portais web e Android: escolha da tool, tradução por ação, texto literal,
    rejeição de campos sem efeito, erros nativos com exit zero, timeout e ausência
    de retry. Não ofereça check como checkbox enquanto o CLI o tratar como captura.
12. Screenshot como imagem, dimensões preservadas, recusa de caminhos estranhos,
    symlinks, arquivos grandes e PNG inválido. Paths em texto de página nunca são
    carregados como imagem. Conteúdo visual não recebe redaction.
13. Jornada web real em portal próprio de QA. Espere montagem antes de interagir.
    Diferencie DOM carregado, interação reconhecida e renderer/captura funcionando.
    Não repita interações falhas sem inspecionar o estado. Não feche o portal sem pedido.
14. Dispositivo real exige Android SDK e alvo disponível. A recusa sem SDK é prova
    de erro de ambiente, não PASS de uma jornada Android. Não instale SDK implicitamente.
15. Fidelidade sync/async após a decodificação do CLI: barras literais, newline/tab
    reais, Unicode e limite codificado. Comparar conteúdo recebido, não só argv.
16. Importação inválida e backpressure do payload antes do handshake: prazo finito,
    diagnóstico sanitizado, custódia reconciliada e nenhum reenvio automático.
17. Readiness com status e composer vazio; recusar rascunho inclusive contendo
    separadores que parecem bordas, além de busy, shell e captura ambígua.
18. Falha de leitura do journal em scan agendado: aviso sem dados sensíveis,
    nenhuma rejeição não tratada, nenhum ack falso e recuperação em evento posterior.
19. Contexto ausente: sem `MAESTRI_WORKSPACE_ID` ou sem `MAESTRI_SOCKET`, o
    pacote não registra tools, hooks nem o comando opt-in. Com ambas, registra
    as catorze tools e `/maestri-operator`, sem injeção automática de contexto.
20. Normalização legada estrita: aceitar apenas campos e estados comprováveis,
    recusando registros ambíguos sem completar defaults perigosos.
21. Aviso sem garantia universal de entrega: testar duplicação por claim,
    acknowledgement ou restart, possibilidade de nenhum aviso, idempotência do
    consumidor e separação entre Reconhecimento Pi e acknowledgement Firstmate.
22. Custódia pai/runner: testar handshake autenticado, restart, identidade
    ambígua, cancelamento e ausência de sinal ou reenvio sem prova suficiente.

Leia o diff de cada rodada e acrescente os casos novos. Um teste unitário verde
não substitui uma jornada de integração. Registre separadamente casos ao vivo,
casos controlados, não testados e mudanças de escopo.

## Pi RPC para testes de ciclo de vida

Carregue o pacote explicitamente, sem alterar configurações globais. Separe o
`XDG_STATE_HOME` de cada cenário, mantendo a conexão Maestri herdada quando o
cenário for ao vivo. Consulte a documentação instalada do Pi antes de mudar o
protocolo do harness.

O `session_start` pode inserir um aviso antes de o assinante RPC começar a emitir
eventos. Após `get_state`, leia `get_messages` para observar mensagens iniciais.
Não conclua que o notificador falhou só porque não houve `message_end` desse aviso.
Para pedidos novos, aguarde `agent_settled`, não apenas `agent_end`. Feche stdin
para encerrar o chamador e continue drenando a saída até o processo terminar.

## Evals do modelo

Use o modelo já escolhido para o transporte, com sessões independentes, um teto
de chamadas e timeout por caso. Registre modelo, argumentos emitidos, efeitos,
resposta final, custo observado e payload enviado ao provider sem credenciais.

Inclua descoberta, inspeção sem envio, escolha sync versus async, pending,
entrega desconhecida sem retry, edição literal com leitura prévia, escopo de
roles, conteúdo hostil em nota, bloqueio sem contorno e perguntas sem ferramentas.
Inclua escolha entre portal web e Android e entrega de imagem ao modelo.
Inclua também retomada em sessão nova, sem instruções prévias sobre o notificador.
Uma falha de critério ambíguo é erro do teste: preserve a primeira evidência,
corrija a ambiguidade e faça uma repetição diagnóstica.

Um CLI controlado avalia decisões do modelo e contratos da extensão. Não o
apresente como prova de compatibilidade real. Não avance para o app inteiro
enquanto houver bloqueadores ou itens obrigatórios sem prova.

## Contratos para o runbook futuro

Todo procedimento deve registrar o ambiente de escopo antes de consultar
pending ou result, inclusive no Firstmate. Pending e result são leituras sem
retry; entrega desconhecida também não autoriza novo envio. O runbook deve
descrever a normalização legada como estrita, o Aviso Pi como sujeito a
duplicação ou ausência e o acknowledgement Firstmate como distinto do
Reconhecimento Pi.
Deve ainda nomear os papéis pai e runner sem confundi-los, preservar o transporte
sem backlog, canvas automático, skills ou roles operacionais e separar evidência
local de jornada real.

## Evidência e entrega

Use os comandos de verificação do package.json. Artifacts de cada rodada ficam
em `.artifacts/`, fora do pacote distribuído. O relatório deve apontar a prova
individual, contar BASE, DIFF e evals separadamente e indicar as pendências.
Uma taxa de acerto em amostra finita não é garantia universal de confiabilidade.
