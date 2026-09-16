# Escopo do waiter e do Firstmate

**Status:** accepted

## Contexto

Waiter e Firstmate consultam recibos externos. Permitir que um UUID bastasse
facilitaria a retomada a partir de outro terminal, mas enfraqueceria o isolamento
entre workspaces e terminais.

## Decisão

Ambos exigem `MAESTRI_WORKSPACE_ID` e `MAESTRI_TERMINAL_ID` no ambiente. Um UUID
não funciona como capacidade cross-scope.

## Consequências

O contrato de escopo é uniforme e a privacidade é previsível, ao custo de exigir
o ambiente correto em toda consulta externa e de recusar UUIDs estrangeiros.
