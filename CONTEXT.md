# Transporte Maestri para Pi

Este contexto nomeia o transporte entre Pi e os recursos nativos do Maestri.

## Language

**Agente conectado**:
Um terminal alcançável pelo terminal chamador no grafo de conexões do Maestri.
_Avoid_: Worker, frente, papel operacional

**Pedido async**:
Um pedido durável a um agente conectado, consultável por identificador sem bloquear o chamador até a resposta.
_Avoid_: Tarefa de projeto, workflow

**Envio**:
O ato de encaminhar um Pedido async ao agente destinatário.
_Avoid_: Entrega, entrega de trabalho

**Entrega**:
O estado do transporte sobre o encaminhamento de um Pedido async; não significa que o trabalho foi concluído.
_Avoid_: Entrega de trabalho, conclusão da tarefa

**Entrega de trabalho**:
O resultado substantivo produzido para o pedido, distinto do estado de transporte e da Resposta.
_Avoid_: Entrega, confirmação de transporte

**Resposta**:
O conteúdo devolvido pelo destinatário dentro dos delimitadores do pedido; não prova, por si só, que o trabalho foi concluído corretamente.
_Avoid_: Entrega, prova de execução correta

**Recibo**:
O registro durável do pedido, de seus estados e da custódia do transporte.
_Avoid_: Backlog, briefing

**Escopo de transporte**:
O par workspace e terminal chamador que delimita a autoridade para consultar e repetir pedidos.
_Avoid_: Identidade operacional, capacidade global

**Aviso Pi**:
O aviso ao chamador de que há um resultado async consultável; receber o aviso não é o seu Reconhecimento Pi.
_Avoid_: acknowledgement Firstmate, entrega de trabalho

**Reconhecimento Pi**:
O ato do chamador consultar o resultado anunciado pelo Aviso Pi.
_Avoid_: acknowledgement Firstmate, confirmação de entrega de trabalho

**Acknowledgement Firstmate**:
A confirmação do Firstmate sobre o aviso externo, separada do Reconhecimento Pi e da leitura do resultado.
_Avoid_: Reconhecimento Pi, ack do transporte

**Retenção**:
A disponibilidade de Recibos e resultados sujeita a critérios de elegibilidade e limpeza oportunística, sem promessa de prazo rígido para apagamento ou permanência mínima.
_Avoid_: Garantia temporal, expiração contratual

**Nota conectada**:
Uma nota alcançável pelo chamador por conexões do Maestri, sujeita às permissões de leitura e edição do aplicativo.
_Avoid_: Memória automática, instrução injetada

**Quiescência de atualização**:
A condição em que os produtores anteriores não podem mais iniciar ou alterar pedidos, após drenagem ou encerramento coordenado.
_Avoid_: Agente ocioso, ausência momentânea de atividade
