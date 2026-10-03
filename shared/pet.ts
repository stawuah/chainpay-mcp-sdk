/** Public, walletless community-pet contract. All timestamps are server milliseconds. */
export const PET_ACTIONS = ['charge','play','polish','pat','ball','collect','coin','game','secret','wake'] as const;
export type PetAction = typeof PET_ACTIONS[number];
export type PetFavorite = 'ball' | 'collect' | 'polish';
export interface PetNeeds { battery: number; joy: number; cleanliness: number }
export interface PetMemory { id: string; at: number; kind: string; text: string }
export interface PetWorld { needs: PetNeeds; lowPower: boolean; lastUpdated: number; napAnchor: number; favorite: PetFavorite | null; props: string[]; revision: number; habitDay: number }
export interface PetState { needs: PetNeeds; lowPower: boolean; sleeping: boolean; mood: 'low-power'|'sleepy'|'content'|'bright'; nextNapAt: number; napUntil: number|null; favorite: PetFavorite|null; props: string[]; revision: number; serverTime: number; recentMemories: PetMemory[]; suggestedAction: PetAction }
export type PetSnapshot = PetState;
export interface PetActionResult { state: PetState; outcome: 'accepted'|'full'|'cooldown'|'local'; replayed: boolean }
export interface PetDailyAggregate { day: number; counts: Record<string, number> }
export interface PetMemoriesResult { memories: PetMemory[]; nextBefore: number|null; aggregates: PetDailyAggregate[] }
export const HOUR = 3_600_000, DAY = 24*HOUR, AWAKE = 4*HOUR, NAP = 10*60_000, CYCLE = AWAKE+NAP;
export function initialWorld(now: number): PetWorld { return { needs: {battery:80,joy:80,cleanliness:80}, lowPower:false,lastUpdated:now,napAnchor:now+AWAKE,favorite:null,props:[],revision:0,habitDay:Math.floor(now/DAY) }; }
function sleepSince(anchor: number, time: number): number { const elapsed = Math.max(0,time-anchor); return Math.floor(elapsed/CYCLE)*NAP+Math.min(NAP,elapsed%CYCLE); }
export function advanceWorld(world: PetWorld, now: number): PetWorld {
  now = Math.max(now,world.lastUpdated);
  const elapsed = now-world.lastUpdated;
  const sleep = sleepSince(world.napAnchor,now)-sleepSince(world.napAnchor,world.lastUpdated);
  const hours = (elapsed-.7*sleep)/HOUR;
  const needs = {battery:Math.max(10,world.needs.battery-hours),joy:Math.max(10,world.needs.joy-hours*1.5),cleanliness:Math.max(10,world.needs.cleanliness-hours*.75)};
  const lowPower = Object.values(needs).some(n=>n<15) || (world.lowPower && !Object.values(needs).every(n=>n>35));
  return {...world,needs,lowPower,lastUpdated:now};
}
export function petState(world: PetWorld, now: number, recentMemories: PetMemory[] = []): PetState {
  now = Math.max(now, world.lastUpdated);
  const w=advanceWorld(world,now), since=now-w.napAnchor;
  const cycleStart=w.napAnchor+Math.max(0,Math.floor(since/CYCLE))*CYCLE;
  const sleeping=since>=0 && now-cycleStart<NAP;
  const suggestedAction: PetAction = w.needs.battery<=w.needs.joy && w.needs.battery<=w.needs.cleanliness?'charge':w.needs.joy<=w.needs.cleanliness?'play':'polish';
  return {needs:w.needs,lowPower:w.lowPower,sleeping,mood:w.lowPower?'low-power':sleeping?'sleepy':Math.min(...Object.values(w.needs))>70?'bright':'content',nextNapAt:since<0?w.napAnchor:sleeping?cycleStart:cycleStart+CYCLE,napUntil:sleeping?cycleStart+NAP:null,favorite:w.favorite,props:w.props,revision:w.revision,serverTime:now,recentMemories,suggestedAction};
}
export function careNeed(action: PetAction): keyof PetNeeds|null { return action==='charge'?'battery':action==='polish'?'cleanliness':['play','ball','game'].includes(action)?'joy':null; }
export function applyCare(world: PetWorld, action: PetAction, now: number): PetWorld {
  now = Math.max(now, world.lastUpdated);
  const w=advanceWorld(world,now), key=careNeed(action);
  if(key) w.needs[key]=Math.min(100,w.needs[key]+50);
  if(action==='wake' && petState(w,now).sleeping) w.napAnchor=now+AWAKE;
  w.lowPower=Object.values(w.needs).some(n=>n<15)||(w.lowPower&&!Object.values(w.needs).every(n=>n>35));
  return w;
}
export function chooseFavorite(scores: Record<PetFavorite,{count:number;days:number}>, current: PetFavorite|null): PetFavorite|null {
  const eligible=(['ball','collect','polish'] as const).filter(k=>scores[k].days>=2);
  const maximum=Math.max(0,...eligible.map(k=>scores[k].count));
  if(current && eligible.includes(current) && scores[current].count===maximum) return current;
  return eligible.find(k=>scores[k].count===maximum)??current;
}
