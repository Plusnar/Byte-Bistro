import { getLanguage, t } from "./index";

/**
 * Names for a model's paintable parts, in the design tool.
 *
 * Material names come from the models: Portuguese in the local packs ("Cas_RosaClaro"),
 * English in the others ("dark wood", "glass"). Each word is looked up in either language
 * and written in the current one, with its modifiers where that language puts them: after
 * the noun in Portuguese ("Rosa claro"), before it in English ("Light pink").
 */

/**
 * [Portuguese spellings, English spellings, written Portuguese, written English, kind]:
 * 0 a noun, 1 a modifier (a colour, a finish), 2 a shade of a colour ("claro", "dark").
 */
type Word = readonly [readonly string[], readonly string[], string, string, 0 | 1 | 2];

const WORDS: readonly Word[] = [
  [["acucar"], ["sugar"], "açúcar", "sugar", 0],
  [["agua"], ["water"], "água", "water", 0],
  [["algodao"], ["cotton"], "algodão", "cotton", 0],
  [["amarela", "amarelo"], ["yellow"], "amarelo", "yellow", 1],
  [["damasco"], ["apricot"], "damasco", "apricot", 1],
  [["assado"], ["roast"], "assado", "roast", 1],
  [["azul"], ["blue"], "azul", "blue", 1],
  [["azulejo"], ["tile"], "azulejo", "tile", 0],
  [["barbaro"], ["barbarian"], "bárbaro", "barbarian", 0],
  [["batata"], ["potato"], "batata", "potato", 0],
  [["binario"], ["binary"], "binário", "binary", 1],
  [["biscoito"], ["biscuit"], "biscoito", "biscuit", 0],
  [["bloco"], ["block"], "bloco", "block", 0],
  [["bolo"], ["cake"], "bolo", "cake", 0],
  [["branca", "branco"], ["white"], "branco", "white", 1],
  [["bronze"], ["bronze"], "bronze", "bronze", 1],
  [["armario"], ["cabinetry"], "armário", "cabinetry", 0],
  [["cache"], ["cache"], "cache", "cache", 0],
  [["caramelo"], ["caramel"], "caramelo", "caramel", 0],
  [["casquinha"], ["cone"], "casquinha", "cone", 0],
  [["ceramica"], ["ceramic"], "cerâmica", "ceramic", 0],
  [["cerveja"], ["beer"], "cerveja", "beer", 0],
  [["chama"], ["flame"], "chama", "flame", 0],
  [["champanhe"], ["champagne"], "champanhe", "champagne", 0],
  [["personagem"], ["character"], "personagem", "character", 0],
  [["carvao"], ["charcoal"], "carvão", "charcoal", 1],
  [["chocolate"], ["chocolate"], "chocolate", "chocolate", 0],
  [["chucrute"], ["sauerkraut"], "chucrute", "sauerkraut", 0],
  [["churros"], ["churros"], "churros", "churros", 0],
  [["cinza"], ["grey", "gray"], "cinza", "grey", 1],
  [["circuito"], ["circuit"], "circuito", "circuit", 0],
  [["cidade"], ["city"], "cidade", "city", 0],
  [["clara", "claro"], ["light"], "claro", "light", 2],
  [["cores"], ["colormap"], "cores", "colours", 0],
  [["concreto"], ["concrete"], "concreto", "concrete", 0],
  [["contatos"], ["contacts"], "contatos", "contacts", 0],
  [["refrigerante"], ["cooling"], "refrigerante", "cooling", 1],
  [["bancada"], ["countertop"], "bancada", "countertop", 0],
  [["couro"], ["leather"], "couro", "leather", 0],
  [["creme"], ["cream"], "creme", "cream", 0],
  [["cristal"], ["crystal"], "cristal", "crystal", 0],
  [["escura", "escuro"], ["dark"], "escuro", "dark", 2],
  [["dados"], ["data"], "dados", "data", 0],
  [["degrau"], ["step"], "degrau", "step", 0],
  [["difusor"], ["diffuser"], "difusor", "diffuser", 0],
  [["doce"], ["sweet"], "doce", "sweet", 1],
  [["dourado", "dourada"], ["golden", "gold"], "dourado", "golden", 1],
  [["borda", "bordas"], ["edge", "edges"], "borda", "edge", 0],
  [["esmalte"], ["enamel"], "esmalte", "enamel", 0],
  [["enxaimel"], ["timber"], "enxaimel", "half-timber", 0],
  [["espuma"], ["foam"], "espuma", "foam", 0],
  [["farofa"], [], "farofa", "farofa", 0],
  [["feno"], ["hay"], "feno", "hay", 0],
  [["ferro"], ["iron"], "ferro", "iron", 0],
  [["flor"], ["flower"], "flor", "flower", 0],
  [["fluido"], ["fluid"], "fluido", "fluid", 0],
  [["fogo"], ["fire"], "fogo", "fire", 0],
  [["folha"], ["leaf"], "folha", "leaf", 0],
  [["forte"], ["deep"], "forte", "deep", 2],
  [["floresta"], ["forest"], "floresta", "forest", 0],
  [["fragmento"], ["fragment"], "fragmento", "fragment", 0],
  [["fresta"], ["gap"], "fresta", "gap", 0],
  [["fundo"], ["background"], "fundo", "background", 0],
  [["moveis"], ["furniture"], "móveis", "furniture", 0],
  [["geranio"], ["geranium"], "gerânio", "geranium", 0],
  [["vidro"], ["glass"], "vidro", "glass", 0],
  [["grama"], ["grass"], "grama", "grass", 0],
  [["verde"], ["green"], "verde", "green", 1],
  [["rejunte"], ["grout"], "rejunte", "grout", 0],
  [["puxadores"], ["handles"], "puxadores", "handles", 0],
  [["brilho"], ["highlight"], "brilho", "highlight", 0],
  [["mel"], ["honey"], "mel", "honey", 0],
  [["hortensia"], ["hydrangea"], "hortênsia", "hydrangea", 0],
  [["igreja"], ["church"], "igreja", "church", 0],
  [["ipe"], [], "ipê", "ipê", 0],
  [["cozinha"], ["kitchen"], "cozinha", "kitchen", 0],
  [["cavaleiro"], ["knight"], "cavaleiro", "knight", 0],
  [["lampada"], ["lamp"], "lâmpada", "lamp", 0],
  [["laranja"], ["orange"], "laranja", "orange", 1],
  [["latao"], ["brass"], "latão", "brass", 0],
  [["lilas"], ["lilac"], "lilás", "lilac", 1],
  [["linguica"], ["sausage"], "linguiça", "sausage", 0],
  [["luz"], [], "luz", "light", 0],
  [["maca"], ["apple"], "maçã", "apple", 0],
  [["madeira"], ["wood", "wooden"], "madeira", "wood", 0],
  [["mago"], ["mage"], "mago", "mage", 0],
  [["manto"], ["robe"], "manto", "robe", 0],
  [["marfim"], ["ivory"], "marfim", "ivory", 1],
  [["massa"], ["dough"], "massa", "dough", 0],
  [["metal"], ["metal"], "metal", "metal", 0],
  [["aco"], ["steel"], "aço", "steel", 0],
  [["meia-noite"], ["midnight"], "meia-noite", "midnight", 1],
  [["miolo"], ["crumb"], "miolo", "crumb", 0],
  [["modulo"], ["module"], "módulo", "module", 0],
  [["mostarda"], ["mustard"], "mostarda", "mustard", 0],
  [["forno"], ["oven"], "forno", "oven", 0],
  [["panorama"], ["panorama"], "panorama", "panorama", 0],
  [["papel"], ["paper"], "papel", "paper", 0],
  [["paver"], ["paver"], "paver", "paver", 0],
  [["pessego"], ["peach"], "pêssego", "peach", 1],
  [["pedra"], ["stone"], "pedra", "stone", 0],
  [["pele"], ["skin"], "pele", "skin", 0],
  [["pescoco"], ["neck"], "pescoço", "neck", 0],
  [["pinhao"], [], "pinhão", "pine nut", 0],
  [["pipoca"], ["popcorn"], "pipoca", "popcorn", 0],
  [["reboco"], ["plaster"], "reboco", "plaster", 0],
  [["plataforma"], ["platformer"], "plataforma", "platform", 0],
  [["pombo"], ["pigeon"], "pombo", "pigeon", 0],
  [["porcelana"], ["porcelain"], "porcelana", "porcelain", 0],
  [["porco"], ["pig"], "porco", "pig", 0],
  [["preta", "preto"], ["black"], "preto", "black", 1],
  [["pretzel"], ["pretzel"], "pretzel", "pretzel", 0],
  [["prototipo"], ["prototype"], "protótipo", "prototype", 0],
  [["patrulheiro"], ["ranger"], "patrulheiro", "ranger", 0],
  [["restaurante"], ["restaurant"], "restaurante", "restaurant", 0],
  [["ladino"], ["rogue"], "ladino", "rogue", 0],
  [["rosa"], ["pink"], "rosa", "pink", 1],
  [["roxa", "roxo"], ["purple"], "roxo", "purple", 1],
  [["sal"], ["salt"], "sal", "salt", 0],
  [["salsicha"], [], "salsicha", "sausage", 0],
  [["sombra"], ["shadow"], "sombra", "shadow", 0],
  [["base espacial"], ["spacebits"], "base espacial", "space base", 0],
  [["estatico"], ["static"], "estático", "static", 1],
  [["telha"], ["roof"], "telha", "roof tile", 0],
  [["terra"], ["earth"], "terra", "earth", 0],
  [["terracota"], ["terracotta"], "terracota", "terracotta", 1],
  [["textura"], ["texture"], "textura", "texture", 0],
  [["transparente"], ["transparent"], "transparente", "transparent", 1],
  [["tronco"], ["trunk"], "tronco", "trunk", 0],
  [["baunilha"], ["vanilla"], "baunilha", "vanilla", 0],
  [["vermelha", "vermelho"], ["red"], "vermelho", "red", 1],
  [["parede"], ["wall"], "parede", "wall", 0],
  [["quente"], ["warm"], "quente", "warm", 1],
  [["xadrez"], ["checkered"], "xadrez", "checkered", 1],
];

const fold = (word: string): string => word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const BY_PORTUGUESE = new Map<string, Word>();
const BY_ENGLISH = new Map<string, Word>();
for (const word of WORDS) {
  for (const spelling of word[0]) BY_PORTUGUESE.set(fold(spelling), word);
  for (const spelling of word[1]) BY_ENGLISH.set(spelling, word);
}

/**
 * "rosa claro" → "Rosa claro" / "Light pink"; "dark wood" → "Madeira escuro" / "Dark wood".
 * A word in the language being shown keeps its own spelling (so its agreement), a word
 * from the other language is translated, and an unknown word is kept as it is.
 */
export const localizeMaterialWords = (words: readonly string[]): string => {
  if (words.length === 0) return t("editor.colour");
  const english = getLanguage() === "en";
  const nouns: string[] = [];
  const modifiers: string[] = [];
  const shades: string[] = [];
  for (const raw of words) {
    const word = BY_PORTUGUESE.get(fold(raw)) ?? BY_ENGLISH.get(raw.toLowerCase());
    const isPortuguese = BY_PORTUGUESE.has(fold(raw));
    const written = !word
      ? raw
      : english
        ? word[3]
        : isPortuguese ? raw : word[2];
    [nouns, modifiers, shades][word?.[4] ?? 0]!.push(written);
  }
  // English: "light pink", "dark wood"; Portuguese: "rosa claro", "madeira escura".
  const ordered = english ? [...shades, ...modifiers, ...nouns] : [...nouns, ...modifiers, ...shades];
  const text = ordered.join(" ").toLocaleLowerCase(english ? "en-US" : "pt-BR");
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
};
