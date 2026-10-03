import { ConvexError, v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './_generated/server';
import { advanceWorld, applyCare, careNeed, chooseFavorite, DAY, initialWorld, PET_ACTIONS, petState } from '../shared/pet';
import type { PetAction, PetActionResult, PetFavorite, PetWorld } from '../shared/pet';

function fail(code:string,message:string):never { throw new ConvexError({code,message}); }
function hash(value:unknown):string { if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value)) fail('invalid_argument','Expected a SHA-256 hash'); return value; }
function keys(a:Record<string,unknown>,allowed:string[]) { if(Object.keys(a).some(k=>!allowed.includes(k))) fail('invalid_argument','Unexpected pet argument'); }
async function rate(ctx:MutationCtx,key:string,now:number,max:number,window:number) {
  const bucket=`pet:${key}:${Math.floor(now/window)}`;
  const row=await ctx.db.query('rate_limits').withIndex('by_key',q=>q.eq('key',bucket)).unique();
  if((row?.count??0)>=max) {
    const retryAfterSeconds=Math.max(1,Math.min(86_400,Math.ceil(((Math.floor(now/window)+1)*window-now)/1000)));
    throw new ConvexError({code:'rate_limited',message:'Please give the community pet a moment',retryAfterSeconds});
  }
  if(row) await ctx.db.patch(row._id,{count:row.count+1}); else await ctx.db.insert('rate_limits',{key:bucket,count:1,expires:now+window});
}
async function remember(ctx:MutationCtx,key:string,at:number,kind:string,text:string) {
  const old=await ctx.db.query('pet_memories').withIndex('by_key',q=>q.eq('key',key)).unique();
  if(!old) {
    const latest=await ctx.db.query('pet_memories').withIndex('by_cursor').order('desc').first();
    await ctx.db.insert('pet_memories',{key,at,cursor:Math.max(at*1000,(latest?.cursor??0)+1),kind,text});
  }
}
async function recent(ctx:MutationCtx,before=Number.MAX_SAFE_INTEGER,limit=12) {
  const rows=await ctx.db.query('pet_memories').withIndex('by_cursor',q=>q.lt('cursor',before)).order('desc').take(limit);
  return rows.map(r=>({id:r.key,at:r.at,kind:r.kind,text:r.text}));
}
async function getWorld(ctx:MutationCtx,now:number) {
  const row=await ctx.db.query('pet_world').withIndex('by_key',q=>q.eq('key','community')).unique();
  let world=advanceWorld(row?.world??initialWorld(now),now);
  const day=Math.floor(now/DAY);
  const evaluateHabits=day>world.habitDay;
  if(evaluateHabits) {
    // Evaluate at the latest UTC boundary, over exactly the preceding seven days.
    // Daily summaries avoid scanning an unbounded population of visitor contributions.
    const records=await ctx.db.query('pet_activity_days').withIndex('by_day_activity',q=>q.gte('day',day-7).lt('day',day)).take(21);
    const scores={ball:{count:0,days:0},collect:{count:0,days:0},polish:{count:0,days:0}};
    for(const r of records) { const s=scores[r.activity as PetFavorite]; if(s) {s.count+=r.count;s.days++;} }
    const favorite=chooseFavorite(scores,world.favorite);
    if(favorite!==world.favorite) { await remember(ctx,`favorite:${day}`,now,'favorite',favorite==='ball'?'The community made ball time a favorite.':favorite==='collect'?'A fondness for shiny treasures is growing.':'A polished visor has become a favorite ritual.'); world={...world,favorite,revision:world.revision+1}; }
    world.habitDay=day;
  }
  // Polls project elapsed decay without rewriting the shared document. Only
  // initialization and daily habit evaluation materialize reads; accepted
  // actions persist their complete elapsed simulation through saveWorld.
  if(!row) await ctx.db.insert('pet_world',{key:'community',world});
  else if(evaluateHabits) await ctx.db.patch(row._id,{world});
  return world;
}
async function saveWorld(ctx:MutationCtx,world:PetWorld) { const row=await ctx.db.query('pet_world').withIndex('by_key',q=>q.eq('key','community')).unique(); await ctx.db.patch(row!._id,{world}); }

/** Called exclusively by authenticated backend storage dispatch, in the same transaction. */
export async function petOperation(ctx:MutationCtx,op:string,a:Record<string,unknown>):Promise<unknown> {
  if(process.env.CHAINPAY_SHARED_PET!=='on') fail('unavailable','Community pet is unavailable');
  const now=Date.now();
  if(op==='pet.visitors') {
    keys(a,['tokenHash','peerHash']); const tokenHash=hash(a.tokenHash),peerHash=hash(a.peerHash);
    const old=await ctx.db.query('pet_sessions').withIndex('by_token',q=>q.eq('tokenHash',tokenHash)).unique();
    if(old) { if(old.peerHash!==peerHash||old.expiresAt<=now) fail('unauthorized','Visitor session expired'); return {expiresAt:old.expiresAt}; }
    await rate(ctx,`visitors-burst:${peerHash}`,now,20,60_000);
    await rate(ctx,`visitors:${peerHash}`,now,200,DAY);
    await rate(ctx,'visitors-global',now,10000,DAY);
    const expiresAt=now+30*DAY;
    await ctx.db.insert('pet_sessions',{tokenHash,peerHash,expiresAt,cooldowns:{}});
    return {expiresAt};
  }
  if(op==='pet.memories') {
    keys(a,['before','limit']);
    const before=a.before??Number.MAX_SAFE_INTEGER,limit=a.limit??20;
    if(typeof before!=='number'||!Number.isSafeInteger(before)||before<0||typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>50) fail('invalid_argument','Invalid memory page');
    const memories=await ctx.db.query('pet_memories').withIndex('by_cursor',q=>q.lt('cursor',before)).order('desc').take(limit+1),hasMore=memories.length>limit;
    const rowsPage=memories.slice(0,limit);
    const page=rowsPage.map(r=>({id:r.key,at:r.at,kind:r.kind,text:r.text}));
    const rows=await ctx.db.query('pet_aggregates').withIndex('by_day',q=>q.gte('day',Math.floor(now/DAY)-6)).order('desc').take(7);
    return {memories:page,nextBefore:hasMore?rowsPage[rowsPage.length-1].cursor:null,aggregates:rows.map(r=>({day:r.day,counts:r.counts}))};
  }
  if(op==='pet.state') { keys(a,[]); const world=await getWorld(ctx,now); return petState(world,now,await recent(ctx)); }
  if(op!=='pet.act') fail('invalid_argument','Unknown pet operation');
  keys(a,['tokenHash','commandId','action']);
  const tokenHash=hash(a.tokenHash);
  if(typeof a.commandId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.commandId)) fail('invalid_argument','Expected UUID v4 commandId');
  if(typeof a.action!=='string'||!(PET_ACTIONS as readonly string[]).includes(a.action)) fail('invalid_argument','Unknown pet action');
  const action=a.action as PetAction,commandId=a.commandId;
  const session=await ctx.db.query('pet_sessions').withIndex('by_token',q=>q.eq('tokenHash',tokenHash)).unique();
  if(!session||session.expiresAt<=now) fail('unauthorized','Visitor session expired');
  const old=await ctx.db.query('pet_commands').withIndex('by_token_command',q=>q.eq('tokenHash',tokenHash).eq('commandId',commandId)).unique();
  if(old) { if(old.action!==action) fail('conflict','Command already used for another action'); return {...old.result,replayed:true}; }
  await rate(ctx,`action-session:${tokenHash}`,now,60,60_000);
  await rate(ctx,`action-peer:${session.peerHash}`,now,240,60_000);
  await rate(ctx,`action-day:${tokenHash}`,now,1000,DAY);
  await rate(ctx,'actions-global',now,100000,DAY);
  let world=await getWorld(ctx,now);
  const need=careNeed(action),cooldown=need??action;
  let outcome:PetActionResult['outcome']='accepted';
  if(now-(session.cooldowns[cooldown]??-Infinity)<30_000) outcome='cooldown';
  else if(need && world.needs[need]>=100) outcome='full';
  else if(action==='wake'&&!petState(world,now).sleeping) outcome='local';
  if(outcome==='accepted') {
    const wasLow=world.lowPower;
    world=applyCare(world,action,now); world.revision++;
    await ctx.db.patch(session._id,{cooldowns:{...session.cooldowns,[cooldown]:now}});
    const day=Math.floor(now/DAY);
    const aggregate=await ctx.db.query('pet_aggregates').withIndex('by_day',q=>q.eq('day',day)).unique();
    const counts={...aggregate?.counts,[action]:(aggregate?.counts[action]??0)+1};
    if(aggregate) await ctx.db.patch(aggregate._id,{counts}); else await ctx.db.insert('pet_aggregates',{day,counts});
    const activity:PetFavorite|null=['ball','game','play'].includes(action)?'ball':action==='collect'?'collect':action==='polish'?'polish':null;
    if(activity) {
      const contributed=await ctx.db.query('pet_contributions').withIndex('by_token_activity_day',q=>q.eq('tokenHash',tokenHash).eq('activity',activity).eq('day',day)).unique();
      if(!contributed) {
        await ctx.db.insert('pet_contributions',{tokenHash,activity,day,at:now});
        const total=await ctx.db.query('pet_activity_days').withIndex('by_day_activity',q=>q.eq('day',day).eq('activity',activity)).unique();
        if(total) await ctx.db.patch(total._id,{count:total.count+1}); else await ctx.db.insert('pet_activity_days',{day,activity,count:1});
      }
    }
    const firsts:Record<PetAction,string>={charge:'Someone gave the community pet its first charge.',play:'The first play break brought a little joy.',polish:'Someone polished the visor for the first time.',pat:'The community pet leaned into its first gentle pat.',ball:'The first ball game rolled through the room.',collect:'A shiny washer joined the treasure shelf.',coin:'The first pretend coin game jingled through the room.',game:'The community finished its first Allowance game.',secret:'Someone discovered a tiny blue star.',wake:'Someone gently woke the community pet.'};
    await remember(ctx,`first:${action}`,now,'first',firsts[action]);
    if(action==='collect'&&!world.props.includes('shiny-washer')) world.props.push('shiny-washer');
    if(action==='secret'&&!world.props.includes('blue-star')) world.props.push('blue-star');
    if(wasLow&&!world.lowPower) await remember(ctx,`recovery:${world.revision}`,now,'recovery','Community care brought the little rascal out of low power.');
    await saveWorld(ctx,world);
  }
  const result:PetActionResult={state:petState(world,now,await recent(ctx)),outcome,replayed:false};
  await ctx.db.insert('pet_commands',{tokenHash,commandId,action,result,expiresAt:session.expiresAt});
  return result;
}

// Bounded garbage collection. Sessions are checked before replay, so deleted
// command records can never resurrect an expired command/session.
export const cleanup = internalMutation({args:{},returns:v.number(),handler:async ctx=>{
  if(process.env.CHAINPAY_MAINTENANCE==='true') return 0;
  const now=Date.now();
  const sessions=await ctx.db.query('pet_sessions').withIndex('by_expires',q=>q.lte('expiresAt',now)).take(200);
  const commands=await ctx.db.query('pet_commands').withIndex('by_expires',q=>q.lte('expiresAt',now)).take(500);
  const contributions=await ctx.db.query('pet_contributions').withIndex('by_at',q=>q.lt('at',now-8*DAY)).take(500);
  for(const row of [...sessions,...commands,...contributions]) await ctx.db.delete(row._id);
  return sessions.length+commands.length+contributions.length;
}});
