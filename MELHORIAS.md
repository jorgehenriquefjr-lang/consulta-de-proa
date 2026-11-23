# Consulta de Proa — versão 2

## Junção e login

Esta versão foi unida à versão publicada e mantém as Cartas de Aproximação (IAC/VAC) e o painel de posicionamento. O acesso exige usuário e senha. Para criar um usuário ou trocar a senha: `python ferramentas/usuarios.py NOME`.

## O que mudou

### Layout
- Novo visual com painel lateral recolhível (Esc), tema claro/escuro (T) e relógio UTC na barra superior.
- No celular o painel vira uma "gaveta" inferior, deixando o mapa visível em cima.
- Resultado com quatro números grandes: proa magnética, distância, proa de volta e tempo estimado.
- Seções recolhíveis: vento, espaço aéreo, METAR/TAF, NOTAM, avisos e sol.
- Mapa abre centrado em SBNV, com escala, coordenada do cursor e legenda que não cobre os controles.
- Opção "números grandes" para leitura no console.

### Busca
- Aceita indicativo, **nome ou cidade** (autocompletar pelo ROTAER, mais perto de SBNV primeiro), Campo 18, **coordenada decimal** e **radial/distância** (`270/15`).
- **Botão direito / toque longo no mapa**: proa, distância e volta até o ponto, mais a coordenada no formato do Campo 18.
- Pontos salvos pelo operador (★ Salvar ponto), além dos três pontos VFR fixos.
- Link `?q=SBGR` abre já com a consulta feita.

### Resultado
- **Proa de volta** para a origem.
- **Correção de vento**: o vento do METAR do destino é preenchido sozinho. Calcula proa corrigida, correção, GS e tempo estimado (TAS configurável).
- **Espaço aéreo na rota**: avisa se a linha direta cruza CTR, ATZ, TMA ou CTA (GeoAISWEB), com distância de entrada e limites. Clique para destacar no mapa.
- Badge VMC/IMC a partir do METAR.
- **NOTAM plotados no mapa** (pino laranja "N"). Ao passar o mouse aparece o texto completo. A posição vem das coordenadas citadas no texto ou da linha Q (centro e raio, com o círculo desenhado quando o raio é de até 50 NM). Quando o NOTAM não traz posição, o pino fica no aeródromo. NOTAM no mesmo ponto viram um pino só, com contador. Passar o mouse na lista destaca o pino, e clicar centraliza no mapa.
- Nascer/pôr do sol e crepúsculo civil (UTC).
- Botão **Copiar** com a fraseologia pronta (também pela tecla C).

### Rota FPL
- Tabela com proa magnética, distância, acumulado e tempo de cada trecho, e totais.
- Velocidade lida do próprio Campo 15 (ex.: N0110).
- Se a base de fixos do DECEA cair, traça o que der em vez de falhar a rota inteira.

### Medir
- Proa magnética e verdadeira, NM e km por trecho, total e tempo estimado. Botão "Desfazer".

### Camadas
- **Dados vetoriais do GeoAISWEB** desenhados na área visível: CTR, ATZ, TMA, CTA e **fixos** (clique num fixo para ver a "proa até aqui").
- Controle de opacidade das cartas, e as cartas ativas são lembradas entre visitas.
- Mapas base: Topográfico, Claro, Escuro e Satélite. Se o OpenTopoMap falhar (os "buracos" cinza), troca sozinho para o Claro.

### Histórico
- Matrícula, observação e operador gravados com cada consulta.
- Filtro, exportação em CSV (abre no Excel) e clique para refazer a consulta.
- Cópia local quando o Firestore não responde.

### Backend (`render_backend/server.py`)
- `/api/buscar_proa` passa a devolver `proa_retorno_magnetica` e aceita `matricula`, `obs` e `operador`.
- Endpoints novos:
  - `/api/declinacao`
  - `/api/buscar_nome`
  - `/api/wfs` (proxy com cache das camadas vetoriais do GeoAISWEB)
  - `/api/notam`

## Publicar

1. **Backend (Render)**: faça o deploy normal. Para ativar o NOTAM, peça a chave
   gratuita da API do AISWEB ao DECEA e cadastre `AISWEB_API_KEY` e
   `AISWEB_API_PASS` nas variáveis de ambiente do serviço. Sem as chaves, a seção
   NOTAM mostra um link para o AISWEB.
2. **Frontend (Firebase)**: `firebase deploy --only hosting`.

## Pendências e observações
- **Nomes de campos não confirmados:** a lista de espaços cruzados procura o nome
  e os limites em campos comuns (`nome`, `limite_inferior` etc.). Não consegui ver
  os nomes reais dos campos das camadas do GeoAISWEB a partir daqui. Se aparecer
  "CTR 1" em vez do nome, me mande o JSON de `/api/wfs?layer=ICA:CTR&bbox=-50,-17,-48,-16`
  que eu ajusto.
- **Áreas restritas, proibidas e perigosas** ainda não entram no alerta, porque não
  sei o nome dessa camada no GeoServer. Com o GetCapabilities, é só acrescentar
  uma linha em `ESPACOS_ROTA` e outra em `VETORES` no `app.js`.
- **Chave do OpenAIP exposta:** a chave fica visível no `app.js`. Restrinja o
  domínio dela no painel do OpenAIP.
