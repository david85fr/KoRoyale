# 🐐 KoRoyale

Un **battle royale de chèvres** sur une île de la Riviera — avec le **circuit de Monaco**
tracé au milieu de la carte. Salons privés pour inviter ses amis, remplissage automatique
par des chèvres IA, coffres, armes, soins, véhicules pilotables, et une seule et même partie
jouable **au clavier/souris, à la manette ou au doigt sur téléphone**.

Aucun compte, aucune installation côté joueur : ça tourne dans le navigateur.

---

## Démarrer

```bash
npm install
npm start
```

Puis ouvrez <http://localhost:8080>. Le port se change avec `PORT=3000 npm start`.

Pour jouer à plusieurs sur le même réseau, les autres joueurs ouvrent
`http://<votre-ip-locale>:8080`. Pour inviter des amis à distance, exposez le port
(tunnel, reverse proxy, hébergeur…) : le jeu ne dépend d'aucun service externe.

### Dans GitHub Codespaces (serveur permanent, mis à jour tout seul)

**Code → Codespaces → Create codespace.** Il n'y a rien à taper : `.devcontainer` enchaîne
tout seul l'installation, le lancement, l'ouverture du port et la mise à jour continue.

1. `npm install` à la création du Codespace ;
2. `scripts/codespace-start.sh` démarre le jeu à **chaque** démarrage du Codespace
   (création, réveil, rebuild) et affiche l'adresse à partager ;
3. le port 8080 est redirigé et déclaré **public** — l'adresse
   `https://<codespace>-8080.app.github.dev` s'envoie telle quelle à vos amis ;
4. un superviseur interroge GitHub **toutes les 30 secondes** : dès qu'un commit arrive sur
   la branche suivie, il le récupère, relance `npm install` si les dépendances ont bougé,
   et redémarre le serveur.

Vous poussez un commit depuis votre machine, et une demi-minute plus tard la partie tourne
avec le nouveau code, sans toucher au Codespace.

```bash
tail -f /tmp/koroyale.log     # le journal du superviseur
cat /tmp/koroyale-url.txt     # l'adresse publique, si vous l'avez perdue
```

Trois garde-fous, tous vérifiés par des tests :

- le serveur est **relancé s'il tombe**, avec une attente progressive (2 s, 4 s, 8 s…) ;
- un **verrou** empêche deux superviseurs de se disputer le port quand le Codespace se
  réveille plusieurs fois ;
- la mise à jour est **refusée** si vous avez des modifications non commitées sur des fichiers
  suivis : votre travail en cours n'est jamais écrasé (les fichiers non suivis, eux, ne
  bloquent rien).

Pour piloter à la main :

```bash
npm run codespace        # le lanceur détaché (ce que fait le Codespace)
npm run serve:watch      # le superviseur au premier plan, pour voir ce qu'il fait
npm start                # juste le serveur, sans mise à jour automatique
```

| Variable | Défaut | Rôle |
|---|---|---|
| `KOROYALE_POLL_MS` | `30000` | Intervalle de scrutation de GitHub |
| `KOROYALE_BRANCH` | branche courante | Branche suivie |
| `KOROYALE_NO_PULL` | — | `1` désactive la mise à jour automatique |
| `KOROYALE_NO_PORT` | — | `1` ne touche pas à la visibilité du port |

Si votre organisation interdit les ports publics, le port reste privé : onglet **PORTS** →
clic droit sur 8080 → **Port Visibility** → **Public**.

Le Codespace ne fait tourner que le *serveur* : le rendu 3D se fait dans le navigateur de
chaque joueur, donc les performances dépendent de leur machine, pas du Codespace. Bonus :
comme Codespaces sert le jeu en HTTPS, le verrouillage du pointeur, le presse-papiers et le
partage natif fonctionnent mieux qu'en `http://` sur le réseau local.

```bash
npm test        # suite complète : serveur + WebSocket + navigateur réel (Chromium)
npm run dev     # rechargement à chaud du serveur
node tests/headless-match.mjs 40 solo   # simule une partie de 40 IA, sans navigateur
node tests/tools/tour.mjs               # captures d'écran guidées du circuit
node tests/tools/drive2.mjs             # conduit chaque véhicule à travers le réseau
```

Les tests ne se contentent pas d'appeler des fonctions : ils lancent le vrai serveur,
ouvrent le jeu dans **Chromium**, créent un salon, démarrent une partie, sautent de
l'hélicoptère, marchent au clavier, et vérifient qu'aucune erreur JavaScript n'est apparue.
Les captures d'écran atterrissent dans `tests/screenshots/`.

---

## La carte : « Le Rocher des Chèvres »

Une île de 1 800 × 1 800 m. Le **circuit de Monaco** (2,3 km) occupe la moitié nord et
enferme le port Hercule. Le tracé est fidèle dans son enchaînement et son relief :

| Secteur | Ce qu'on y trouve |
|---|---|
| **Les Stands** | Ligne droite, garages, caisses de stand (butin de qualité) |
| **Sainte-Dévote** | Virage serré en montée |
| **Beau Rivage** | 30 m de dénivelé jusqu'au Casino |
| **Place du Casino** | Le monument, l'Hôtel de Paris, la zone la plus riche |
| **Mirabeau / Épingle du Fairmont** | L'épingle à 180°, la plus lente du championnat |
| **Portier → Le Tunnel** | Le tunnel couvert : à l'abri des tirs venus d'en haut |
| **Nouvelle Chicane** | Sortie de tunnel, pleine vitesse |
| **Tabac → La Piscine** | Le complexe de la piscine en bord de quai |
| **La Rascasse → Anthony Noghès** | Retour vers la ligne droite |

Autour du circuit : le **Rocher** et sa vieille ville sur un plateau à falaises, le **Mont
Chèvre** (172 m, domaine naturel des chèvres), l'**Alpage** et sa ferme, la **Forêt de
Vintimille**, **La Turbie**, l'**Héliport**, la **Plage du Larvotto**, et le **port** avec
ses yachts praticables.

Tout est **généré à partir d'une graine** : le serveur et chaque client construisent
exactement la même carte, ce qui évite de télécharger le moindre modèle 3D.

---

## Jouer

### Les chèvres

Ce ne sont pas des humains déguisés. Une chèvre :

- **saute deux fois** (double saut) ;
- **escalade** les parois : contre un mur, maintenez `Espace` et elle grimpe ;
- **encorne** au corps à corps (`V`), avec un vrai recul ;
- **nage**, **broute** (la botte d'herbe soigne dans la durée) ;
- **bêle**, ce qui s'entend de loin.

### Le déroulement

1. **Salon** — on se retrouve, on discute, l'hôte règle le mode et lance.
2. **Largage** — tout le monde survole l'île, saute quand il veut, parapente automatique.
3. **Butin** — coffres (garantis avec une arme), butin au sol, largages de ravitaillement.
4. **La Brume du Rocher** — le cercle se referme en 8 phases, de plus en plus vite.
5. **Dernière chèvre debout.**

En Duo et en Troupeau (4), une chèvre abattue passe **à terre** : un coéquipier peut la
relever en 8 secondes.

### L'arsenal

| Arme | Ce que ça fait |
|---|---|
| Coup de corne | Toujours disponible, 34 dégâts, ça projette |
| Bêlier 9 mm | Pistolet fiable |
| Chevrotine SMG | Cadence élevée, courte portée |
| Fusil d'Assaut « Bouquetin » | Le couteau suisse |
| Cornes de Boue | Fusil à pompe, discussions de couloir |
| Carabine du Berger | Semi-auto à lunette |
| Tir de Falaise | Sniper, ×2,4 à la tête |
| Lance-Foin | Roquettes, dégâts de zone |
| Crotte explosive | Grenade (maintenir `G` pour doser) |

Cinq raretés (commune → légendaire) qui modifient dégâts, cadence, chargeur et rechargement.

Soins : bandage, trousse, botte d'herbe fraîche (soin progressif), petit et grand lait de
chèvre (boucliers), et la **meule de fromage** qui rend tout — si vous la trouvez.

### Les véhicules

Tous fonctionnels, tous pilotables, tous destructibles.

| Véhicule | Places | Pointe | Pour quoi faire |
|---|---|---|---|
| **Monoplace GP** | 2 | ~190 km/h | Le circuit, évidemment |
| **Buggy des Alpages** | 4 | ~95 km/h | Le tout-terrain, il grimpe |
| **Scooter du Port** | 2 | ~75 km/h | Se faufiler en ville |
| **Vedette du Port** | 4 | ~70 km/h | Le port et le tour de l'île |

Modèle arcade avec limite d'adhérence latérale (on sous-vire si on force), frein à main,
carburant, dégâts de collision — et on écrase les chèvres imprudentes. La simulation est
découpée en sous-pas pour qu'aucune voiture ne traverse une glissière à 190 km/h.

---

## Les commandes

### Clavier et souris (AZERTY **et** QWERTY)

| | |
|---|---|
| `ZQSD` / `WASD` / flèches | Se déplacer |
| `Espace` | Sauter, double saut, escalader, ouvrir le parapente |
| `Maj gauche` | Sprinter |
| `Ctrl` | S'accroupir |
| Clic gauche / droit | Tirer / viser |
| `R` | Recharger |
| `E` | Interagir (maintenir pour un coffre) |
| `F` | Monter dans / sortir d'un véhicule |
| `V` | Coup de corne |
| `G` | Grenade (maintenir pour doser) |
| `1`–`5`, molette | Emplacements |
| `Tab` | Tableau des scores |
| `M` / `I` / `Entrée` / `Échap` | Carte / inventaire / chat / menu |
| `H` / `B` / `X` | Klaxon / emote / marqueur |

### Manette

Sticks pour se déplacer et viser (zone morte radiale, courbe quadratique), `RT`/`LT` pour
tirer et viser, `A` saut, `B` accroupi, `X` interagir, `Y` changer d'arme, `LB` grenade,
`RB` coup de corne, croix directionnelle pour les emplacements, `L3` sprint, `R3` marqueur.
Vibration si la manette la gère.

### Tactile

Surcouche affichée seulement après un vrai contact tactile : **joystick flottant** à gauche
(il apparaît là où le pouce se pose), zone de visée à droite (glisser pour la caméra, tap
pour tirer, double tap pour viser), boutons d'action de 56 px minimum, barre d'emplacements
en bas. La disposition change toute seule selon le contexte : à pied, au volant
(accélérateur/frein/klaxon/sortir) ou en vol (parapente/carte).

---

## Les salons

- **Partie rapide** — rejoint le premier salon public disponible, ou en crée un.
- **Créer un salon** — génère un code à 5 caractères (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
  sans caractère ambigu) et un **lien d'invitation** `…/?salon=CODE` à envoyer à ses amis.
- **Rejoindre** — par code ou en cliquant dans la liste des salons publics.

L'hôte règle : mode (Solo / Duo / Troupeau), taille du salon (2 à 40), remplissage
automatique par des IA, difficulté des IA, tir allié, salon public ou privé. Il peut ajouter
des IA à la main, exclure un joueur, et lancer la partie.

**S'il n'y a pas assez de joueurs, des chèvres IA complètent le salon** jusqu'à la taille
choisie — on peut donc jouer seul immédiatement. Et si un joueur se déconnecte en pleine
partie, **une IA reprend sa chèvre** pour ne pas fausser le classement.

### Les chèvres IA

Quatre niveaux : *chevreau*, *biquette*, *bouc*, *bouquetin* — ils changent la précision, le
temps de réaction, la portée d'engagement et le courage. Elles choisissent un point de
largage, sautent au bon moment, cherchent les coffres, comparent les armes, se soignent,
fuient quand elles sont mal en point, prennent des véhicules pour les longues rotations,
suivent le circuit par points de passage, lancent des grenades, et se dégagent toutes seules
quand elles se coincent.

---

## Comment c'est fait

```
shared/     code identique serveur et client (c'est le contrat)
  constants.js   réglages de jeu       track.js      le circuit de Monaco
  math.js        géométrie             mapdata.js    génération de la carte
  rng.js         aléatoire déterministe collision.js  monde de collision
  loot.js        armes et objets       movement.js   physique chèvre + véhicules
  protocol.js    messages réseau
server/
  index.js  express + WebSocket        room.js   un salon, sa boucle
  lobby.js  connexions et annuaire     match.js  la partie, 20 Hz, autoritaire
  sim/      world, player, combat, vehicle, loot, storm, bots
client/
  index.html  js/main.js  js/game.js  js/net.js  js/input.js  js/audio.js
  js/render/  world, goat, vehicles, effects, pickups
  js/ui/      lobby, hud
tests/      intégration (serveur réel) + simulation de partie sans navigateur
```

**Serveur autoritaire à 20 Hz.** Le client envoie ses intentions, le serveur simule et
renvoie des instantanés filtrés par zone d'intérêt (220 m). Le client **prédit** ses propres
déplacements en rejouant `shared/movement.js` — le même code exactement — puis réconcilie
avec l'état du serveur et absorbe l'écart en quelques images. Les autres joueurs sont
interpolés avec 100 ms de retard. Les tirs sont compensés en latence : le serveur rembobine
les positions selon le ping du tireur.

**Rien à télécharger.** Pas de modèle 3D, pas de texture, pas de fichier son : les chèvres,
les voitures, la ville, la mer et tous les bruitages sont générés par le code. Le seul
fichier tiers est three.js, servi depuis `node_modules`.

**Budget.** Une partie de 40 joueurs coûte environ 3,5 ms par tick sur un cœur — soit 7 % du
budget de 50 ms.

---

## Réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `NODE_ENV` | — | `production` active le cache des fichiers statiques |

`GET /health` renvoie l'état du serveur (connexions, salons, parties en cours).
`GET /api/rooms` liste les salons publics.

---

## Licence

Projet de jeu à but récréatif. « Monaco » et les noms de virages sont employés à titre
descriptif ; aucune affiliation avec l'Automobile Club de Monaco ou la Formule 1.
