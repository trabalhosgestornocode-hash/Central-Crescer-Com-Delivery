# iFood — várias lojas na mesma unidade (Subway Sanduíches + Subway Saladas)

**Status: implementado e testado SÓ localmente (branch `feat/ifood-multi-merchant-saladas`). Nada foi aplicado, publicado nem cadastrado em produção.**
Cada passo de produção abaixo exige autorização expressa.

## 1. Por que a Saladas não aparece hoje
* O polling de Events pede ao iFood apenas os merchants das **conexões** cadastradas. A Subway Saci — Matriz tem 1 conexão e 1 merchant.
  A Saladas não está cadastrada em lugar nenhum, então o iFood nunca devolve os eventos dela.
* O banco só aceita **uma conexão viva por unidade** (`uq_ifood_conexao_unidade_viva`) e um merchant por conexão. Uma segunda conexão na
  mesma unidade é impossível, e várias partes do código assumem 1 conexão por unidade (`obterConexaoViva` usa `maybeSingle()`).

## 2. Modelo (migration 117, 100 % aditiva)
A loja principal continua em `ifood_conexoes.merchant_id` (nada muda). As lojas ADICIONAIS da conexão ficam em `ifood_conexao_lojas`
(mesma credencial Order, mesma unidade, mesmo token; o tenant vem sempre da conexão):

```
pendente --liberar(supervisionado)--> liberada --iFood aceita--> ativa
                                         |                        |
                                         +--403 / 3 tentativas----+--403--> bloqueada --liberar(supervisionado)--> liberada
desativada <-- (qualquer estado, pelo gestor)        desativada --> pendente (recadastro)
```
* Só `ativa` e `liberada` entram no polling. `pendente`, `bloqueada` e `desativada` **nunca**.
* **Bloqueio persistente:** um 403 (`unauthorizedMerchants`) grava `bloqueada` no banco (e em memória). A loja não volta ao polling a cada
  ciclo, nem depois de reiniciar/deploy. A única saída é `ifood-loja-extra-liberar.sql` (o banco exige `app.liberacao_supervisionada = on`).
* **Tentativas limitadas:** uma loja `liberada` conta cada entrada no polling (atômico no banco); a 4ª vira `bloqueada` (`TENTATIVAS_ESGOTADAS`).
  Sem conseguir contar a tentativa, o poller NÃO consulta.
* Integridade (gatilho): organização/unidade iguais às da conexão; o merchant não pode ser a loja principal de uma conexão viva nem repetir em outra
  loja viva; conexão/merchant/tenant imutáveis; estado inicial sempre `pendente`; transições validadas.
* Backend-only: RLS ligada, nenhuma policy; `anon`/`authenticated`/PUBLIC sem acesso; `service_role` só `select/insert/update`.

## 3. Poller
* Mesmo pedido de polling por conexão: o header `x-polling-merchants` leva `[principal, ...lojas adicionais]` (mesmo token). Um polling por ciclo,
  nunca abaixo de 30 s. Não há consulta paralela.
* Falha da Saladas não derruba a Sanduíches: o 403 tira só a loja recusada e o MESMO ciclo segue com as demais (a Sanduíches é processada e reconhecida).
* ACK, deduplicação (`event_id` e `order_id` únicos), lease e fencing: inalterados. Eventos da Saladas são processados e reconhecidos normalmente.
* **Falha segura:** se a tabela ainda não existir (código publicado antes da migration), ou o banco falhar ao ler as lojas, o ciclo segue só com a
  principal (um aviso no log, uma vez). Sem nenhuma loja cadastrada o comportamento é **idêntico** ao de antes (testado).
* Logs: `events.loja_extra_ativada`, `events.loja_extra_bloqueada`, `events.loja_extra_nao_consultada`, `events.loja_extra_bloqueio_nao_gravado`,
  `events.lojas_extras_indisponiveis`.

## 4. Checklist
* Já consolidava a unidade inteira (consulta por organização + unidade; `order_id` único ⇒ sem duplicar). Agora cada pedido leva a ORIGEM
  (`loja.rotulo`), e a resposta traz `lojas[]` (rótulo, principal, estado, contagem do dia) — **só quando a unidade tem mais de uma loja**.
  Com uma loja só a resposta é idêntica à de antes.
* Rótulo: o configurado na loja adicional > nome da conexão > nome curto vindo do próprio iFood (`merchant.name`, ex.: "Subway Saladas - Saci" →
  "Saladas") > genérico. Nunca expõe `merchant_id` nem o nome inteiro.
* Aviso `loja_sem_recebimento` (nível atenção) enquanto uma loja cadastrada ainda não está sendo recebida (pendente / em verificação / bloqueada):
  a equipe não pode achar que a lista está completa.
* Os indicadores (preparo, entrega, vida, contagens) já consideram todos os pedidos da unidade. O Checklist não acompanha entregadores
  (só a etapa "espera do entregador"), então não há acompanhamento para duplicar.

## 5. Sequência segura de publicação (cada passo, com autorização)
Pré-requisitos humanos: (a) no Portal do Parceiro, o aplicativo da Central (Order) está **autorizado para a loja Saladas**; (b) o Gestor de Pedidos da
Saladas fica **aberto e acompanhado** (a consulta mantém a loja ABERTA no iFood enquanto durar o polling); (c) o mesmo Gerente acompanha as duas lojas.

1. PR + revisão. Nenhum efeito em produção.
2. **Migration 117** (aditiva, sem lock relevante). Código antigo ignora a tabela.
3. **Deploy do código**. O polling da Sanduíches pausa ~70 s na troca de instância (o iFood retém os eventos; nada se perde). Conferir `/health`,
   lease e que o polling segue só com `[Sanduíches]`.
4. `ifood-loja-extra-cadastrar.sql` → `pendente`. Nada muda no polling; o Checklist avisa "aguardando liberação".
5. Conferir (a) e (b). `ifood-loja-extra-liberar.sql` → `liberada`. No ciclo seguinte o poller faz UMA consulta incluindo a Saladas:
   * aceita → `ativa`, eventos processados normalmente (nada descartado);
   * 403 → `bloqueada` (persistente), a Sanduíches segue; **parar e voltar ao Portal**;
6. A primeira consulta traz o acúmulo de eventos da Saladas (na ativação da Sanduíches foram 384 eventos num ciclo de ~160 s, maior que o lease de 90 s;
   o fencing cobre). Os detalhes saem 10 por ciclo; o aviso `detalhes_ausentes` cai sozinho.
7. Validar com pedidos reais das duas lojas contra o Gestor de cada uma (número, tipo, status, origem, sem duplicar).

**Reversão (sem deploy):** `ifood-loja-extra-desativar.sql` — o poller para de consultar a loja no próximo ciclo. Os pedidos gravados permanecem.
`117_rollback.sql` só se não houver loja `ativa`/`liberada`.

## 6. O que NÃO está provado (precisa de produção)
* Se a autorização atual do iFood cobre a Saladas (só o Portal ou a primeira consulta supervisionada respondem). Um 403 é tratado com segurança, mas
  consultar merchant não autorizado é infração — por isso o passo 5 só ocorre depois de conferir o Portal.
* Se o token já emitido cobre uma autorização feita depois (a documentação do iFood diz que pode ser necessário um novo token; o refresh da Central
  emite novos tokens).
* O comportamento real do iFood com dois merchants no mesmo header (documentado e usado no modo centralizado, mas não exercitado em produção).
