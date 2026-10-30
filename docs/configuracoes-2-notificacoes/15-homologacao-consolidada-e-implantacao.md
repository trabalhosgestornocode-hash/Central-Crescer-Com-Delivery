# 15 — Homologação consolidada no Supabase de teste, SMTP e sequência exata de implantação

Data: 30/10/2026. Branch `feat/configuracoes-2-central-notificacoes` (local à frente do PR #55). Nada aplicado em produção nem no teste.

## 1. Pré-voo do Supabase de teste (feito, só leitura)

| Item | Resultado |
|---|---|
| Identidade | `wiqqsxnysbzhcrzrrean` = "teste-multiempresarial" (constante `PROJETO_TESTE_REF` do código); produção é `uqybgauuxcrqzquultfu` — projetos diferentes |
| Plano | Organização em plano **Pro** (backups diários automáticos — restauração total como último recurso) |
| Migrations registradas | 17 (o projeto foi montado por outros meios; objetos de 101–104 existem sem registro) |
| Dependências ausentes | objetos de 105, 109, 110, 116–118, 124, 127, 131. **Nenhum** é referenciado por 132–135 |
| Funções que 132–135 tocam/usam | `agendar`, `resolver`, `reservar_envio`, `remapear` com hash **idêntico** ao da main e ao de produção |
| Tráfego de outra frente | último evento iFood 30/09 (0 em 7 dias); último login 19/10; 1 evento de auditoria em 24 h (transferência de unidade da homologação 131, hoje 05:58 UTC); conexões: só PostgREST e exportador de métricas |
| WhatsApp | 2 conexões DISCONNECTED; fila pendente 0 |
| Homologação iFood | 132–135 não tocam nenhum objeto `ifood_*`; as migrations do iFood pendentes ali (116–118, 124) **não** serão aplicadas |
| Backup lógico | manifesto com impressão digital (colunas, funções+ACL, gatilhos, políticas, ACL/RLS, config) e hashes dos dados tocados; o corpo de `agendar` é o da 104 da main |

**Conclusão:** o projeto é seguro para receber **somente** 132–135 (não a cadeia inteira).

## 2. Por que não "completar a sequência"

Aplicar 105–131 só para fechar números mudaria o estado da homologação do iFood (116–118, 124 pendentes de propósito ali) e não é
necessário para 132–135. Fica fora.

## 3. Execução consolidada (3 confirmações, com acompanhamento)

O conector exige **uma confirmação humana por chamada de escrita** (expira em 2 minutos). Não será contornado. Em vez de 12 chamadas
(4 arquivos × aplicar/reverter/reaplicar), o pacote junta tudo em **3**:

| # | Ação | Confirmação | Ensaio local (cópia da cadeia da main, uma transação) |
|---|---|---|---|
| 0 | `node backend/testes-seguros/supabase-teste/gerar_pacote.mjs <pasta>` — registrar os SHA-256 | — | `pacote_aplicar.sql` 84.818 B, `pacote_reverter.sql` 13.359 B |
| 1 | `apply_migration` com `pacote_aplicar.sql` (uma transação: tudo ou nada) | **1ª** | OK; `agendar` = `7b7c0a59…` |
| 2 | `validar_pos_132_135.sql` (só leitura) — todos os itens `ok: true` | — | itens estruturais OK; os 3 de dados comparam com os hashes do TESTE |
| 3 | `validar_postgrest.mjs` com a chave **publicável** — nada novo exposto a `anon` | — | (só no remoto) |
| 4 | Prova de recuperação: `pacote_reverter.sql`; comparar a impressão digital com a de antes | **2ª** | OK; impressão digital IDÊNTICA; `agendar` = `f37bf6e1…` |
| 5 | Reaplicar `pacote_aplicar.sql`; repetir 2 e 3 | **3ª** | OK |

**Critério de parada:** qualquer item da validação diferente de `ok: true` → reverter (passo 4) e parar.
**Estado final:** 132–135 aplicadas no TESTE; seleção por unidade desligada; categorias novas inativas; snapshot vazio.

**Alternativas, se não houver como acompanhar as confirmações:**
- (a) Só o passo 1 (uma confirmação) + validação; a prova de recuperação fica a do ensaio local (idêntico, uma transação) e o backup diário.
- (b) Você mesmo cola `pacote_aplicar.sql` no SQL Editor do projeto de TESTE (uma execução); eu rodo as validações só leitura.
- (c) Projeto Supabase dedicado só para esta homologação (custo; exige montar a cadeia da main inteira).

## 4. SMTP e variáveis (para o convite de usuário — DEP-2)

**No Supabase Auth do projeto (configuração do painel, não variáveis do app):**
1. SMTP próprio (host, porta, usuário, senha, remetente) — o SMTP padrão do Supabase é limitado e só serve para teste.
2. *URL Configuration*: Site URL e Redirect URLs incluindo `<APP_URL_PUBLICA>/convite-usuario.html`.
3. Template "Invite user" em português com `{{ .ConfirmationURL }}`.
4. Validade do link do e-mail do Supabase: conferir; se for menor que 72 h, quem não aceitar a tempo precisa de novo convite
   (o admin cancela e convida de novo).

**Variáveis do app (nenhuma criada):**

| Variável | Para quê | Sem ela |
|---|---|---|
| `APP_URL_PUBLICA` | **nova** — origem https dos links (convite da Central e de usuário); cabeçalhos da requisição nunca são usados em produção | Produção: criar link = 503 antes de gravar |
| `USUARIOS_CONVITE_EMAIL=supabase` | liga o envio do convite de usuário | Conta nova = 409 "peça ao Administrador da plataforma"; **nada é criado**; conta existente recebe o acesso como antes |
| `NOTIFICACOES_SEGREDO_MESTRE` | cifra/HMAC da Central e dos convites | Central só consulta; convites indisponíveis |

**Homologação do e-mail (futura, só no TESTE):** caixa de e-mail controlada; conferir que o redirect preserva `#t=` e que o
aceite cria o vínculo; nenhuma conta real de cliente.

## 5. Sequência exata de implantação (cada passo com autorização própria)

1. **Push** dos commits locais para o PR #55 e revisão do diff atualizado.
2. **Homologação no TESTE** (§3) — recomendada antes de produção.
3. **Produção — migrations** (janela fora do agendamento do D-1): `pacote_aplicar.sql` gerado do MESMO commit, numa transação;
   depois `validar_pos_132_135.sql` adaptado (itens estruturais + D-1 equivalente em todas as unidades; hashes de dados de produção
   capturados antes).
4. **Merge** do PR (dispara o deploy do backend + frontend). Conferir `/health` e os arquivos novos servidos.
5. **Variáveis** (opcional nesta fase): `APP_URL_PUBLICA` e `NOTIFICACOES_SEGREDO_MESTRE`. **Nunca** em produção:
   `NOTIFICACOES_OTP_TRANSPORTE`, `NOTIFICACOES_AMBIENTE_ISOLADO`, `NOTIFICACOES_M3_ATIVACAO_HABILITADA`.
6. **Observação de 24 h** do D-1 (quantidade de mensagens e destinatários igual à véspera).
7. **Depois, separadamente:** SMTP + `USUARIOS_CONVITE_EMAIL`, corte do fuso, provedor oficial/termos, M3.

## 6. Recuperação

Igual ao doc 14 §3, com o pacote: reverter o código primeiro (o código anterior convive com 132–135); só se necessário,
`pacote_reverter.sql` numa transação (ensaiado: impressão digital idêntica à de antes). Exportar antes as tabelas novas que tiverem linhas.
