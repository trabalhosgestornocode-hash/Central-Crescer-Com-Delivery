# 05 — Verificação por OTP e consentimento

> Decisão de produto já tomada: verificação por código temporário enviado ao número. **Nada disso foi implementado nem disparado nesta missão.**

## 1. Quatro coisas que não se confundem

| Conceito | Prova | Quem produz | Onde fica | Hoje |
|---|---|---|---|---|
| **Posse do número** | OTP correto dentro do prazo | o titular | `contatos_whatsapp.verificado_em` + desafio consumido (`comunicacao_desafios_titular`) | atestado do operador (`validarWhatsApp`) |
| **Consentimento de comunicação** | aceite explícito de categorias, com texto versionado exibido | o titular | `comunicacao_consentimentos` (append-only) | boolean global `contatos_whatsapp.consentimento`, marcado pelo operador |
| **Autorização para ver dados da unidade** | o conteúdo das mensagens expõe dados operacionais da unidade (pedidos, cancelamentos, fechamento) | o **administrador** da empresa/unidade decide quem recebe | escopo `comunicacao_destinatario_escopos` (doc 06) | implícito: todo destinatário da empresa recebe de todas as unidades |
| **Permissão administrativa** | papel do usuário logado | a plataforma (papéis) | `notificacoes.gerenciar` (nova) | só Painel ADM |

Consequências:
- **O OTP não é consentimento.** Ele só prova posse naquele momento. O consentimento é uma segunda tela, com ação própria.
- O consentimento do titular **não** dá ao titular nenhum acesso à plataforma, nem amplia a autorização dada pelo administrador. Se o titular aceitou "Fechamento", mas o administrador não liberou essa unidade para ele, nada sai.
- O administrador **não** consente pelo titular.

## 2. Fluxo proposto

O convite é iniciado pelo administrador. A verificação e o consentimento são feitos pelo titular, sem conta na Crescer.

```
ADMIN (Configurações → Notificações)                       TITULAR (celular)
1. informa nome, papel, WhatsApp, unidades, categorias pretendidas
2. backend normaliza (E.164, normalizarTelefone existente) e valida
3. cria CONVITE (token aleatório de 32 bytes; hash no banco; validade 72 h)
4. tela mostra o link curto / QR do convite para o admin repassar
   (ou o admin abre no próprio celular do titular, presencialmente)
                                                        5. abre /notificacoes/convite/{token}
                                                           vê: empresa, quem convidou, unidades, categorias pretendidas
                                                        6. toca "Receber código no WhatsApp"
7. cria DESAFIO OTP (invalida os anteriores do mesmo convite) e envia
   o código por template de AUTENTICAÇÃO (provedor oficial — doc 08)
                                                        8. digita o código (6 dígitos)
9. valida: hash, prazo, uso único, tentativas, concorrência
   → posse comprovada (verificado_em, desafio consumido)
                                                        10. tela de CONSENTIMENTO: texto versionado, uma caixa por categoria
                                                            (nenhuma pré-marcada), link para a política
                                                        11. "Aceito receber" (ou "Não quero receber")
12. grava CONSENTIMENTO (uma linha por categoria aceita, versão e hash do texto, origem `link_convite_otp`)
13. vínculo → ATIVO nas unidades/categorias autorizadas pelo admin ∩ aceitas pelo titular
14. confirmação ao titular na tela (+ link permanente de gestão, doc §5) e ao admin na Central
```

Por que o convite é **iniciado pelo titular** (passo 6) e não pelo admin:
- reduz o abuso de "disparar código para qualquer número";
- garante que quem digita o OTP é quem está com o link;
- evita que o admin precise intermediar o código: **o código nunca passa pelo admin**.

Templates de autenticação **não aceitam URL** (doc 08), por isso o link do convite chega por um canal escolhido pelo admin (presencial, QR, e-mail ou outro). Alternativa possível: um template **utility** com o link do convite, mas ele exige opt-in prévio (decisão D-5).

## 3. Parâmetros do OTP

| Parâmetro | Valor | Implementação |
|---|---|---|
| Código | 6 dígitos numéricos | `crypto.randomInt(0, 1_000_000)` com zero à esquerda (CSPRNG do Node; nunca `Math.random`) |
| Validade | 5 min | `expira_em = now() + 5 min` (gravado pelo banco). Template com `code_expiration_minutes = 5` |
| Uso único | sim | `consumido_em` preenchido de forma atômica (`update … where consumido_em is null and invalidado_em is null and expira_em > now() returning`) |
| Tentativas | máx. 5 por desafio | contador incrementado **antes** da comparação, na mesma transação; o 5º erro invalida o desafio |
| Reenvio | mínimo de 60 s | `ultimo_envio_em`; o desafio novo invalida o anterior |
| Limites adicionais | por telefone (5 desafios/h, 10/dia), por convite (5/dia), por IP (20/h), por unidade (50/dia), por usuário admin (convites: 30/dia) | reaproveitar `shared/rateLimit.js` (memória) **e** contagem no banco (vale entre instâncias). Valores iniciais sujeitos à decisão D-8 |
| Armazenamento | `HMAC-SHA256(segredo, desafio_id ‖ código)` | segredo `NOTIFICACOES_OTP_SEGREDO` (env nova, ≥ 32 bytes, fora do banco). Nunca o código em claro, nem em log ou auditoria |
| Comparação | tempo constante | `crypto.timingSafeEqual` sobre buffers de mesmo tamanho |
| Invalidação | desafios anteriores do mesmo telefone × convite | ao criar um novo; ao consumir; ao revogar o convite |
| Anti-enumeração | respostas idênticas | "Se o número puder receber, enviaremos um código" + mesmo tempo de resposta. A página de gestão (§5) nunca revela se o número está cadastrado |
| Concorrência / replay | consumo atômico; token do convite com hash; desafio ligado ao convite **e** ao telefone | dois envios simultâneos do mesmo código: só um consome. Repetir uma requisição já aceita → 409 sem efeito |
| Auditoria | eventos `desafio_criado`, `codigo_enviado` (com `provider_message_id`), `tentativa_falhou` (contador), `verificado`, `expirado`, `bloqueado_por_limite` | sem código, sem número completo (máscara), IP só como hash com sal rotativo |
| Transporte | template de **autenticação** pelo provedor oficial | **nunca** pelo Baileys. Até o provedor existir: transporte `noop` (simulação, testes) |

## 4. Consentimento

### 4.1 Registro (`comunicacao_consentimentos`, append-only)

Cada linha é **um evento**:
- `id`, `contato_whatsapp_id`, `organizacao_id`, `unidade_id` (nulo = empresa);
- `categoria`, `acao` (`CONCEDIDO` | `REVOGADO` | `PREFERENCIA_ALTERADA` | `LEGADO_ATESTADO`);
- `termo_versao`, `termo_hash` (sha256 do texto exibido);
- `origem` (`link_convite_otp` | `pagina_gestao_otp` | `palavra_chave_inbound` | `pedido_registrado_admin` | `migracao_legado`), `evidencia_id` (desafio/mensagem), `registrado_por` (admin, quando houver);
- `ip_hash`, `user_agent_resumo`, `ocorreu_em`.

O estado atual é a **última** ação por (contato, empresa, categoria). A view/função `comunicacao_consentimento_vigente` alimenta `comunicacao_resolver_destinatarios`.

### 4.2 Texto versionado (`comunicacao_termos`)

Campos: `versao`, `vigente_desde`, `texto` e `hash`. O texto diz:
- o nome da empresa (exigência da Meta: identificar o negócio);
- as categorias;
- a frequência esperada;
- como sair;
- a política de privacidade.

Mudança material de texto = nova versão. Quem consentiu na anterior continua válido para as **mesmas** categorias, e categoria nova exige novo aceite.

### 4.3 LGPD

- **Base legal (Lei 13.709/2018).** Para avisos operacionais B2B a responsáveis de empresas clientes, o **legítimo interesse/execução de contrato** pode ser defensável, mas o projeto adota **consentimento** porque:
  - a decisão de produto pede consentimento explícito;
  - a política da Meta exige opt-in;
  - parte dos destinatários é pessoa física (gerentes).

  A escolha final da base legal é jurídica (**decisão D-1**).
- **Requisitos do consentimento (art. 8º):** livre, informado e inequívoco; por finalidade (categoria); revogável a qualquer momento por procedimento **gratuito e facilitado** (§5º); e o **ônus da prova é do controlador** (§2º). O livro-razão com texto versionado existe para cumprir esse ônus.
- **Minimização:**
  - guarda-se o número (necessário), o nome e o papel informados pelo admin;
  - o IP fica só como hash;
  - nada de foto de perfil na Central do cliente (a Central da equipe já tem cache próprio).
- **Retenção (proposta, decisão D-10):**
  - livro-razão: mantido enquanto houver vínculo + 5 anos (prova);
  - desafios OTP: apagados 30 dias após expirar/consumir (só contadores);
  - conteúdo de mensagens: segue a política geral a definir (o inbox já tem retenção, `comunicacao.inbox.retencao.js`).

## 5. Revogação sem depender do administrador

O titular tem **três caminhos**, todos gratuitos:

1. **Link de gestão** (enviado na confirmação e no rodapé das mensagens, quando o transporte permitir):
   - página `/notificacoes/gerenciar`;
   - o titular informa o número, recebe o OTP e vê **todas** as empresas e categorias que o têm como destinatário;
   - pode desligar categorias, sair de uma empresa ou sair de tudo, sem conta Crescer;
   - sessão curta (15 min) ligada ao desafio consumido;
   - resposta anti-enumeração.
2. **Palavra-chave** no WhatsApp ("SAIR", "PARAR", "STOP"):
   - o inbound grava `REVOGADO` de todas as categorias da empresa remetente, ou de todas se ambíguo, e confirma;
   - depende de inbound confiável, que é fraco hoje com o Baileys (histórico de travamento) e nativo na API oficial via webhook.
3. **Pedido registrado:**
   - o titular pede ao admin ou à equipe Crescer, que registra com motivo (`pedido_registrado_admin`);
   - é auditado e o efeito é imediato.

Revogação sempre vence: a policy já bloqueia `OPT_OUT`/`NO_CONSENT` (fail-closed). Uma mensagem já agendada é cancelada no JIT, porque a checagem acontece antes do envio, como hoje.

## 6. Riscos específicos

| Risco | Mitigação |
|---|---|
| **Número reciclado** (a operadora reatribui a linha) | posse revalidada periodicamente (proposta: 12 meses, decisão D-6); falhas PERMANENTE seguidas suspendem; a troca de titular exige novo OTP **e** novo consentimento (o consentimento é da pessoa que provou posse, não do número para sempre) |
| **Troca de titular dentro da empresa** (gerente saiu) | o admin remove o vínculo, o histórico permanece e o novo gerente passa pelo fluxo completo |
| **Revogação de acesso do usuário** | destinatário ≠ usuário: desligar um login **não** desliga o destinatário automaticamente. A Central mostra "ligado ao usuário X (inativo)" e sugere revisar |
| **Admin malicioso tenta assinar por outro** | OTP e aceite no dispositivo do titular; o admin nunca vê o código; os limites contêm abuso |
| **Mesmo número em várias empresas** (5 hoje) | o consentimento é **por empresa**; a página de gestão mostra todas |
| **Engenharia social do código** | o template oficial inclui o aviso de segurança ("não compartilhe este código"); o link do convite expira em 72 h |
