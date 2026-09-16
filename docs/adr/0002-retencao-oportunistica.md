# Retenção oportunística

**Status:** accepted

## Contexto

Recibos e capturas precisam de uma política de retenção. Um prazo rígido e um
daemon dedicado dariam previsibilidade temporal, mas transformariam a custódia
em uma obrigação operacional contínua.

## Decisão

A elegibilidade considera sete dias e os 200 pedidos em estado terminal mais recentes,
prevalecendo o conjunto menor. A limpeza ocorre oportunisticamente durante
atividade, sem daemon dedicado, hard deadline de apagamento ou garantia de
retenção mínima.

## Consequências

Um registro elegível pode permanecer até uma atividade de limpeza, e um registro
também pode não estar disponível sem que isso autorize reenvio. Consumidores não
podem depender de permanência temporal; em troca, a política não exige um
processo operacional dedicado.
