# Fodinha online

Jogo de Fodinha com baralho espanhol, salas com código, chat, emojis, pausa e dinheiro de mentira.
Não tem nenhuma dependência: só precisa do Node 18 ou mais novo.

## Rodar no seu computador
    node server.js
Abra http://localhost:3000. Para jogar com amigos na mesma rede, use o IP do seu computador.

## Colocar na internet (para qualquer pessoa criar conta e jogar)
Você precisa de uma hospedagem que rode Node ou Docker e aceite WebSocket
(Railway, Fly.io, Render e parecidos). Passos gerais:
1. Suba esta pasta para um repositório no GitHub.
2. Na hospedagem, crie um serviço apontando para o repositório. Ela usa o `Dockerfile`
   (ou o comando `npm start`). A porta vem da variável `PORT`, que a hospedagem já define.
3. **Importante:** as contas ficam no arquivo `users.json`, dentro da pasta indicada por `DATA_DIR`
   (no Docker, `/data`). Crie um volume/disco persistente montado nessa pasta. Sem isso, as contas
   somem toda vez que o serviço reinicia. Hospedagens grátis sem disco perdem as contas.
4. Use o endereço https que a hospedagem dá. O jogo troca sozinho para wss.

## Como funciona
- O servidor embaralha, distribui e valida tudo. Cada jogador recebe só as cartas que pode ver.
- Dinheiro: cada rodada cada um aposta um valor. Quem acertou a aposta de vazas recebe de volta o que
  apostou e divide, na proporcao do que apostou, o dinheiro de quem errou. Se todos acertarem ou ninguem
  acertar, cada um so recebe a propria aposta de volta.
- Pausa: qualquer jogador pausa; só quem pausou (ou o anfitrião) continua.
- Quem cai da conexão é substituído por um bot até voltar. Sair da sala deixa um bot no lugar.
- Partidas ficam na memória do servidor: se ele reiniciar, as partidas em andamento acabam
  (as contas continuam).

## Testes
    node test/sim.js     (Node 22+: joga uma partida inteira com 3 jogadores e confere as regras)

## Hospedagem gratis (Render)
Este projeto ja vem com `render.yaml`. No site da Render: New > Blueprint (ou Web Service) > escolha o
repositorio > plano Free. O endereco fica algo como https://fodinha.onrender.com.
No plano gratis o servico dorme depois de um tempo sem uso (a primeira abertura demora cerca de 1 minuto)
e os arquivos nao sao permanentes: as contas podem sumir quando ele reinicia. Visitante sempre funciona.
