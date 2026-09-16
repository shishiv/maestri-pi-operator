# Atualização dos locks com quiescência

**Status:** accepted

## Contexto

O protocolo antigo coordenava escritores por arquivos JSON `.lock`. O novo
module de locks usa compare-and-swap transacional em SQLite, disponível no
Node 24. Esses protocolos não se excluem mutuamente: um produtor antigo pode
ignorar o lock novo. Uma ponte que recupere markers antigos também herdaria
a corrida de remoção de um sucessor.

## Decisão

A atualização exige quiescência: drenar ou encerrar todos os Pi/runners antigos
que possam escrever no store antes de usar a nova versão. Não há suporte a
rolling upgrade com produtores dos dois protocolos.

Markers JSON legados, vivos, stale ou incertos, causam recusa; o transporte
não os apaga automaticamente. A ausência de marker não comprova quiescência:
essa é uma pré-condição operacional explícita, não uma inferência do código.

## Consequências

Os recibos e as capturas são preservados. Depois da quiescência, artifacts de
lock antigos remanescentes exigem inspeção e resolução pelo operador; não se
apagam recibos nem o banco de coordenação para contornar uma recusa.

Atualizações exigem uma janela coordenada, em troca de não alegar exclusão
entre protocolos incompatíveis. Restart e recuperação dentro do protocolo
suportado continuam duráveis. Esta decisão não autoriza parada ou migração
automática de processos e dados existentes.
