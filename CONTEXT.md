# Transporte Maestri para Pi

Este projeto conecta chamadas do Pi aos recursos nativos do Maestri.

## Language

**Agente conectado**:
Um terminal alcançável pelo terminal chamador no grafo de conexões do Maestri.
_Avoid_: Worker, frente, papel operacional

**Pedido async**:
Um envio durável a um agente conectado, consultável por um identificador sem bloquear o chamador até a resposta.
_Avoid_: Tarefa de projeto, workflow

**Entrega**:
O estado de envio do pedido ao agente destinatário, separado da obtenção da resposta.
_Avoid_: Conclusão da tarefa

**Resposta**:
O conteúdo devolvido pelo destinatário dentro dos delimitadores do pedido.
_Avoid_: Prova de que a tarefa foi concluída corretamente

**Recibo**:
O registro durável do pedido, de seus estados e da custódia do processo de transporte.
_Avoid_: Backlog, briefing

**Escopo de transporte**:
O par workspace e terminal chamador que delimita acesso e repetição idempotente dos pedidos.
_Avoid_: Identidade operacional

**Nota conectada**:
Uma nota alcançável pelo chamador por conexões do Maestri, sujeita às permissões de leitura e edição do aplicativo.
_Avoid_: Memória automática, instrução injetada
