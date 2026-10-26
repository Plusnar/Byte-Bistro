/**
 * Portuguese names for the third-party models in the editor's catalogue.
 *
 * KayKit and Kenney models are named after their files ("Bush 1 A Color1", "Colored Block
 * Blue"), in English. This turns those names into Portuguese word by word, with the one
 * change of order Portuguese needs: a modifier that comes before its noun in English moves
 * after it ("Colored Block Blue" → "Bloco colorido azul"). Letters, numbers and sizes
 * ("2x2x2") are kept. Names read literally at times, but every one reads in Portuguese.
 */

const WORDS: Readonly<Record<string, string>> = {
  // Colours and finishes
  yellow: "amarelo", red: "vermelho", blue: "azul", green: "verde", orange: "laranja",
  white: "branco", dark: "escuro", neutral: "neutro", gold: "dourado", silver: "prateado",
  copper: "cobre", metal: "metal", color: "cor", colored: "colorido", striped: "listrado",
  stripe: "listra", stripes: "listras", checkerboard: "xadrez", decorated: "decorado",
  decorative: "decorativo", glass: "vidro", wood: "madeira", stone: "pedra", padded: "acolchoado",
  primitive: "primitivo", basic: "básico", special: "especial", prototype: "protótipo",
  // Sizes and shapes
  large: "grande", big: "grande", medium: "médio", small: "pequeno", tall: "alto", high: "alto",
  low: "baixo", short: "curto", long: "longo", wide: "largo", thin: "fino", flat: "plano",
  round: "redondo", rounded: "arredondado", square: "quadrado", rectangle: "retângulo",
  oval: "oval", cube: "cubo", cone: "cone", diamond: "losango", heart: "coração", star: "estrela",
  cross: "cruz", half: "metade", full: "cheio", empty: "vazio", whole: "inteiro", wholer: "inteiro",
  double: "duplo", single: "simples", multi: "múltiplo", quad: "quádruplo", split: "dividido",
  angled: "inclinado", curved: "curvo", curve: "curva", bend: "dobra", diagonal: "diagonal",
  straight: "reto", horizontal: "horizontal", vertical: "vertical", deep: "fundo", broken: "quebrado",
  bare: "vazio", open: "aberto", closed: "fechado", hanging: "pendurado", standing: "em pé",
  stacked: "empilhado", packed: "embalado", raised: "elevado", crushed: "triturado",
  // Parts and positions
  corner: "canto", innercorner: "canto interno", outercorner: "canto externo", opencorner: "canto aberto",
  inner: "interno", outer: "externo", side: "lado", sides: "lados", singlesided: "de um lado",
  end: "ponta", middle: "meio", top: "topo", bottom: "base", base: "base", left: "esquerdo",
  right: "direito", part: "parte", pieces: "peças", detail: "detalhe", edge: "borda",
  junction: "junção", intersection: "cruzamento", crossing: "travessia", transition: "transição",
  connection: "conexão", template: "modelo", variation: "variação", layer: "camada", set: "conjunto",
  bundle: "maço", area: "área", lines: "linhas", loop: "laço", finish: "chegada", return: "devolução",
  selection: "seleção", general: "geral", movementbasic: "movimento básico", with: "com",
  // Building
  wall: "parede", floor: "piso", tile: "ladrilho", roof: "telhado", roofmodule: "módulo de telhado",
  door: "porta", doorway: "vão de porta", window: "janela", stairs: "escada", pillar: "pilar",
  column: "coluna", arch: "arco", beam: "viga", bracing: "travamento", strut: "escora",
  platform: "plataforma", slope: "rampa", structure: "estrutura", block: "bloco", bricks: "tijolos",
  fence: "cerca", railing: "corrimão", barrier: "barreira", gate: "portão", bars: "barras",
  catwalk: "passarela", corridor: "corredor", tunnel: "túnel", bridge: "ponte", room: "sala",
  basemodule: "módulo de base", build: "construção", panel: "painel", landingpad: "plataforma de pouso",
  cargodepot: "depósito de carga", garage: "garagem", hole: "buraco", bump: "lombada",
  // Nature
  tree: "árvore", bush: "arbusto", grass: "grama", rock: "rocha", rocks: "rochas", boulder: "pedregulho",
  crystal: "cristal", crystals: "cristais", snow: "neve", sand: "areia", dirt: "terra",
  gravel: "cascalho", terrain: "terreno", river: "rio", water: "água", waterfall: "cachoeira",
  lava: "lava", hill: "colina", cactus: "cacto", spring: "mola", ice: "gelo",
  // Animals
  animal: "animal", beaver: "castor", bee: "abelha", bunny: "coelho", cat: "gato",
  caterpillar: "lagarta", chick: "pintinho", cow: "vaca", crab: "caranguejo", deer: "cervo",
  dog: "cachorro", elephant: "elefante", fish: "peixe", fox: "raposa", giraffe: "girafa",
  hog: "javali", koala: "coala", lion: "leão", monkey: "macaco", panda: "panda", parrot: "papagaio",
  penguin: "pinguim", pig: "porco", polar: "polar", tiger: "tigre", turkey: "peru",
  // Furniture and home
  table: "mesa", chair: "cadeira", stool: "banquinho", armchair: "poltrona", couch: "sofá",
  bed: "cama", pillow: "travesseiro", pillows: "almofadas", lamp: "luminária", rug: "tapete",
  shelf: "prateleira", cabinet: "armário", book: "livro", pictureframe: "porta-retrato",
  kitchentable: "mesa de cozinha", kitchencabinet: "armário de cozinha",
  kitchencounter: "balcão de cozinha", countertop: "bancada", backsplash: "revestimento",
  sink: "pia", stove: "fogão", oven: "forno", fridge: "geladeira", freezer: "freezer",
  freezers: "freezers", extractorhood: "coifa", dishrack: "escorredor", towelrail: "toalheiro",
  papertowel: "papel-toalha", orderwindow: "janela de pedidos", trash: "lixo", kitchen: "cozinha",
  containers: "potes", basket: "cesta", cart: "carrinho", bag: "saco", bags: "sacos",
  box: "caixa", boxes: "caixas", crate: "caixote", barrel: "barril", pallet: "palete", jar: "pote",
  can: "lata", bottle: "garrafa", carton: "caixa de leite", mug: "caneca", cup: "xícara",
  saucer: "pires", plate: "prato", plates: "pratos", bowl: "tigela", lid: "tampa", pan: "frigideira",
  pot: "panela", knife: "faca", fork: "garfo", spoon: "colher", spatula: "espátula", whisk: "batedor",
  rollingpin: "rolo de massa", cuttingboard: "tábua de corte", cutting: "de corte", board: "tábua",
  chopping: "de picar", stand: "suporte", bar: "barra",
  utensil: "utensílio", chopstick: "hashi", chopstic: "hashi", skewer: "espeto", slicer: "fatiador",
  cutter: "cortador", grater: "ralador", mortar: "pilão", pestle: "socador", mill: "moedor",
  shaker: "saleiro", tenderizer: "batedor de carne", steamer: "cesto de vapor", scoop: "concha",
  tajine: "tajine", styrofoam: "isopor", wrapper: "embalagem", menu: "cardápio", display: "vitrine",
  shopping: "compras", cash: "caixa", register: "registradora", employee: "funcionário",
  character: "personagem", sign: "placa", signage: "sinalização", flag: "bandeira", screen: "tela",
  // Food
  food: "comida", ingredient: "ingrediente", apple: "maçã", advocado: "abacate", avocado: "abacate",
  banana: "banana", beet: "beterraba", broccoli: "brócolis", cabbage: "repolho", carrot: "cenoura",
  carrots: "cenouras", cauliflower: "couve-flor", celery: "aipo", cherries: "cerejas",
  coconut: "coco", corn: "milho", eggplant: "berinjela", ginger: "gengibre", grapes: "uvas",
  leek: "alho-poró", lemon: "limão", lettuce: "alface", mushroom: "cogumelo", onion: "cebola",
  onions: "cebolas", paprika: "páprica", pear: "pera", pepper: "pimentão", pineapple: "abacaxi",
  potato: "batata", potatoes: "batatas", pumpkin: "abóbora", radish: "rabanete",
  strawberry: "morango", tomato: "tomate", tomatoes: "tomates", watermelon: "melancia",
  vegetable: "vegetal", vegetables: "legumes", fruit: "fruta", mint: "hortelã", salad: "salada",
  bread: "pão", baguette: "baguete", bun: "pão de hambúrguer", buns: "pães de hambúrguer",
  loaf: "pão de forma", croissant: "croissant", muffin: "muffin", cupcake: "cupcake",
  cake: "bolo", birthday: "aniversário", pie: "torta", donut: "rosquinha", cookie: "biscoito",
  waffle: "waffle", pancakes: "panquecas", pudding: "pudim", sundae: "sundae", popsicle: "picolé",
  lollypop: "pirulito", candy: "bala", chocolate: "chocolate", sprinkles: "confeitos", honey: "mel",
  peanut: "amendoim", butter: "manteiga", whipped: "chantilly", cream: "creme", cheese: "queijo",
  egg: "ovo", ham: "presunto", bacon: "bacon", sausage: "linguiça", meat: "carne", steak: "bife",
  ribs: "costela", mincemeat: "carne moída", patty: "hambúrguer", burger: "hambúrguer",
  vegetableburger: "hambúrguer vegetal", hot: "quente", salmon: "salmão",
  mussel: "mexilhão", roe: "ovas", sushi: "sushi", maki: "maki", dim: "dim", sum: "sum",
  rice: "arroz", soup: "sopa", stew: "ensopado", broth: "caldo", cereal: "cereal",
  fries: "batata frita", taco: "taco", pizza: "pizza", sandwich: "sanduíche", sub: "sanduíche",
  dinner: "jantar", frikandel: "frikandel", speciaal: "especial", sauerkraut: "chucrute",
  mashed: "purê", slice: "fatia", slices: "fatias", cut: "cortado", chopped: "picado",
  cooked: "cozido", uncooked: "cru", raw: "cru", frying: "de fritar", cooking: "de cozinhar",
  dirty: "sujo", ketchup: "ketchup", mustard: "mostarda", musterd: "mostarda", oil: "óleo",
  salt: "sal", soy: "shoyu", coffee: "café", tea: "chá", soda: "refrigerante", wine: "vinho",
  cocktail: "coquetel", frappe: "frapê", chinese: "chinês", japanese: "japonês", bones: "ossos",
  cne: "cone", stick: "palito",
  // Machines and space
  machine: "máquina", conveyor: "esteira", pipe: "cano", valve: "válvula", cables: "cabos",
  lever: "alavanca", button: "botão", piston: "pistão", cog: "engrenagem", crane: "guindaste",
  drill: "furadeira", magnet: "ímã", lift: "elevador", scanner: "scanner", hopper: "funil",
  indicator: "indicador", power: "energia", pad: "plataforma", robot: "robô", arm: "braço",
  windturbine: "turbina eólica", solarpanel: "painel solar", solarpanels: "painéis solares",
  lights: "luzes", lasers: "lasers", mesh: "tela", trailer: "reboque", mining: "mineração",
  lander: "módulo de pouso", spacetruck: "caminhão espacial", ufo: "óvni", cargo: "carga",
  tower: "torre", target: "alvo", spawn: "ponto de início", enemy: "inimigo", warning: "aviso",
  traffic: "trânsito", fortified: "fortificado", oopi: "oopi", rings: "aros",
  hoop: "aro", ball: "bola", coin: "moeda", bomb: "bomba", rotate: "giratório",
  // Weapons and characters (KayKit adventurers)
  arrow: "flecha", arrows: "flechas", bow: "arco", crossbow: "besta", sword: "espada", axe: "machado",
  dagger: "adaga", shield: "escudo", badge: "brasão", spikes: "espinhos", staff: "cajado",
  wand: "varinha", spellbook: "livro de feitiços", quiver: "aljava", smokebomb: "bomba de fumaça",
  ammo: "munição", weapon: "arma", bullet: "projétil", cannonball: "bala de canhão",
  ballista: "balista", cannon: "canhão", catapult: "catapulta", turret: "torreta", burst: "rajada",
  barbarian: "bárbaro", knight: "cavaleiro", mage: "mago", ranger: "patrulheiro", rogue: "ladino",
  hooded: "encapuzado", rig: "esqueleto", withstring: "com corda", "1handed": "de uma mão",
  "2handed": "de duas mãos", dummy: "boneco",
};

/** Words that modify a noun and come before it in English, after it in Portuguese. */
const MODIFIERS = new Set([
  "yellow", "red", "blue", "green", "orange", "white", "dark", "neutral", "gold", "silver",
  "copper", "colored", "striped", "decorated", "decorative", "padded", "primitive", "basic",
  "special", "large", "big", "medium", "small", "tall", "high", "low", "short", "long", "wide",
  "thin", "flat", "round", "rounded", "square", "oval", "double", "single", "multi", "quad",
  "angled", "curved", "straight", "horizontal", "vertical", "deep", "broken", "bare", "open",
  "closed", "hanging", "standing", "stacked", "packed", "raised", "crushed", "inner", "outer",
  "singlesided", "left", "right", "dirty", "cooked", "uncooked", "raw", "chopped", "cut",
  "mashed", "whipped", "hot", "chinese", "japanese", "polar", "fortified", "hooded", "birthday",
  "frying", "cooking", "cutting", "chopping", "shopping", "traffic", "wood", "stone", "glass", "metal",
]);

const KEEP = /^(\d+([.,]\d+)?|[A-Z]|\d+x\d+(x\d+)?|[A-Z]\d*|\d+[A-Za-z]|x\d+)$/;

/** A kept token keeps its case ("A", "2x2x2"); a translated word is lower case. */
const translateWord = (word: string): string => {
  const lower = word.toLowerCase();
  const colour = /^color(\d+)$/.exec(lower);
  if (colour) return `cor ${colour[1]}`;
  if (KEEP.test(word)) return word;
  return (WORDS[lower] ?? word).toLocaleLowerCase("pt-BR");
};

/** One run of words, with English modifiers moved after the first noun they precede. */
const translateRun = (words: readonly string[]): string[] => {
  const leading: string[] = [];
  let index = 0;
  while (index < words.length - 1 && MODIFIERS.has(words[index]!.toLowerCase())) {
    leading.push(words[index]!);
    index += 1;
  }
  const ordered = leading.length ? [words[index]!, ...leading, ...words.slice(index + 1)] : [...words];
  return ordered.map(translateWord);
};

/** "Colored Block Blue (Blue)" → "Bloco colorido azul (azul)". */
export const portugueseAssetName = (english: string): string => {
  const text = english
    .split(/(\([^)]*\))/)
    .filter((part) => part.trim())
    .map((part) => {
      const bracketed = part.startsWith("(");
      const words = (bracketed ? part.slice(1, -1) : part).split(/\s+/).filter(Boolean);
      const translated = translateRun(words).join(" ");
      return bracketed ? `(${translated})` : translated;
    })
    .join(" ");
  return text.charAt(0).toLocaleUpperCase("pt-BR") + text.slice(1);
};

/** Every English word the glossary covers, for the test that keeps it complete. */
export const glossaryCovers = (word: string): boolean => {
  const lower = word.toLowerCase();
  return KEEP.test(word) || /^color\d+$/.test(lower) || lower in WORDS;
};
