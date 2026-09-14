import { ASSET_LIFECYCLE_STATES, type AssetDirectoryProfile, type AssetDirectoryRepository } from '../assets/index.js';
import { LOCATION_TYPES, type LocationDirectoryProfile, type LocationDirectoryRepository } from '../locations/index.js';
import { ORGANIZATION_UNIT_TYPES, type OrganizationUnit, type PeopleDirectoryRepository, type PersonDirectoryProfile } from '../people/index.js';
import {
  EntityResolutionError,
  type AssetReference,
  type AssetResolutionFilters,
  type EntityMatchEvidence,
  type EntityMatchType,
  type EntityReference,
  type EntityResolutionCandidate,
  type EntityResolutionRequest,
  type EntityResolutionResult,
  type EntityType,
  type LocationReference,
  type LocationResolutionFilters,
  type OrganizationReference,
  type OrganizationResolutionFilters,
  type PersonReference,
  type PersonResolutionFilters
} from './model.js';

export * from './model.js';

export interface EntityResolutionServiceOptions {
  people: Pick<PeopleDirectoryRepository,
    'getPersonProfile' | 'findPersonByExternalIdentity' | 'listPersonProfiles'
    | 'findOrganizationUnitById' | 'listOrganizationUnits'>;
  locations: Pick<LocationDirectoryRepository,
    'getLocationProfile' | 'findLocationByExternalReference' | 'listLocationProfiles'>;
  assets: Pick<AssetDirectoryRepository,
    'getAssetProfile' | 'findAssetByExternalReference' | 'listAssetProfiles'>;
}

type MatchField = {
  kind: 'code' | 'name' | 'alias';
  value: string;
  normalization?: { entityType: 'organization' | 'location'; subtype: string };
};
type SearchDocument = { reference: EntityReference; fields: MatchField[] };

export class EntityResolutionService {
  constructor(private readonly options: EntityResolutionServiceOptions) {}

  async resolve(request: EntityResolutionRequest): Promise<EntityResolutionResult> {
    validateRequest(request);
    if (request.lookup.type === 'id') return this.resolveId(request);
    if (request.lookup.type === 'external_id') return this.resolveExternal(request);
    return this.resolveText(request);
  }

  private async resolveId(request: EntityResolutionRequest): Promise<EntityResolutionResult> {
    const id = uuid(request.lookup.type === 'id' ? request.lookup.id : '', 'entity id');
    const reference = await this.referenceById(request, id);
    const input = request.lookup.type === 'id' ? request.lookup.id : '';
    return directResult(request, input, reference, reference ? { type:'id',score:100,matchedField:'id',matchedValue:id } : null);
  }

  private async resolveExternal(request: EntityResolutionRequest): Promise<EntityResolutionResult> {
    if (request.lookup.type !== 'external_id') throw new EntityResolutionError('INVALID_LOOKUP', '外部引用查询无效');
    if (request.entityType === 'organization') throw new EntityResolutionError('UNSUPPORTED_EXTERNAL_REFERENCE', '组织目录尚无外部引用契约');
    const provider = stableCode(request.lookup.provider, 'external provider');
    const tenantKey = stableCode(request.lookup.tenantKey ?? 'default', 'external tenant');
    const externalId = requiredText(request.lookup.externalId, 'external id', 255);
    let reference: EntityReference | null = null;
    if (request.entityType === 'person') {
      const profile = await this.options.people.findPersonByExternalIdentity(provider,tenantKey,externalId);
      if (profile && personEligible(profile,normalizePersonFilters(request.filters))) reference = personReference(profile);
    } else if (request.entityType === 'location') {
      const profile = await this.options.locations.findLocationByExternalReference(provider,tenantKey,externalId);
      if (profile && locationEligible(profile,normalizeLocationFilters(request.filters))) reference = locationReference(profile);
    } else {
      const profile = await this.options.assets.findAssetByExternalReference(provider,tenantKey,externalId);
      if (profile && assetEligible(profile,normalizeAssetFilters(request.filters))) reference = assetReference(profile);
    }
    return directResult(request,externalId,reference,reference ? { type:'external_id',score:100,matchedField:'external_id',matchedValue:externalId } : null);
  }

  private async resolveText(request: EntityResolutionRequest): Promise<EntityResolutionResult> {
    if (request.lookup.type !== 'text') throw new EntityResolutionError('INVALID_LOOKUP', '文本查询无效');
    const input = requiredText(request.lookup.text,'entity query',200);
    const documents = await this.listDocuments(request);
    const matches = documents
      .map((document) => bestCandidate(input,document))
      .filter((candidate): candidate is EntityResolutionCandidate => candidate !== null);
    const exactCodes = matches.filter((candidate) => candidate.match.type === 'code' && candidate.match.score === 100);
    const eligible = exactCodes.length > 0 ? exactCodes : matches;
    eligible.sort(compareCandidates);
    return rankedResult(request,input,eligible,maxCandidates(request.maxCandidates));
  }

  private async referenceById(request: EntityResolutionRequest,id:string):Promise<EntityReference|null>{
    if(request.entityType==='person'){
      const filters=normalizePersonFilters(request.filters);const profile=await this.options.people.getPersonProfile(id);return profile&&personEligible(profile,filters)?personReference(profile):null;
    }
    if(request.entityType==='organization'){
      const filters=normalizeOrganizationFilters(request.filters);const organization=await this.options.people.findOrganizationUnitById(id);return organization&&organizationEligible(organization,filters)?organizationReference(organization):null;
    }
    if(request.entityType==='location'){
      const filters=normalizeLocationFilters(request.filters);const profile=await this.options.locations.getLocationProfile(id);return profile&&locationEligible(profile,filters)?locationReference(profile):null;
    }
    const filters=normalizeAssetFilters(request.filters);const profile=await this.options.assets.getAssetProfile(id);return profile&&assetEligible(profile,filters)?assetReference(profile):null;
  }

  private async listDocuments(request:EntityResolutionRequest):Promise<SearchDocument[]>{
    if(request.entityType==='person'){
      const filters=normalizePersonFilters(request.filters);
      const profiles=await this.options.people.listPersonProfiles({...filters,employmentStatus:'active'});
      return profiles.filter((profile)=>personEligible(profile,filters)).map(personDocument);
    }
    if(request.entityType==='organization'){
      const filters=normalizeOrganizationFilters(request.filters);
      return (await this.options.people.listOrganizationUnits()).filter((item)=>organizationEligible(item,filters)).map(organizationDocument);
    }
    if(request.entityType==='location'){
      const filters=normalizeLocationFilters(request.filters);
      const profiles=await this.options.locations.listLocationProfiles({...filters,status:'active'});
      return profiles.filter((profile)=>locationEligible(profile,filters)).map(locationDocument);
    }
    const filters=normalizeAssetFilters(request.filters);
    const profiles=await this.options.assets.listAssetProfiles({systemId:filters.systemId,typeId:filters.typeId,locationId:filters.locationId});
    return profiles.filter((profile)=>assetEligible(profile,filters)).map(assetDocument);
  }
}

export function createEntityResolutionService(options:EntityResolutionServiceOptions){return new EntityResolutionService(options);}

function personDocument(profile:PersonDirectoryProfile):SearchDocument{return{reference:personReference(profile),fields:[{kind:'code',value:profile.person.employeeNo},{kind:'name',value:profile.person.name}]};}
function organizationDocument(item:OrganizationUnit):SearchDocument{return{reference:organizationReference(item),fields:[{kind:'code',value:item.code},{kind:'name',value:item.name,normalization:{entityType:'organization',subtype:item.unitType}},...(item.shortName?[{kind:'alias' as const,value:item.shortName,normalization:{entityType:'organization' as const,subtype:item.unitType}}]:[])]};}
function locationDocument(profile:LocationDirectoryProfile):SearchDocument{return{reference:locationReference(profile),fields:[
  {kind:'code',value:profile.location.code},{kind:'name',value:profile.location.name,normalization:{entityType:'location',subtype:profile.location.locationType}},
  ...(profile.location.shortName?[{kind:'alias' as const,value:profile.location.shortName,normalization:{entityType:'location' as const,subtype:profile.location.locationType}}]:[]),
  ...profile.aliases.map((alias)=>({kind:'alias' as const,value:alias.alias,normalization:{entityType:'location' as const,subtype:profile.location.locationType}})),
  ...profile.stationLines.flatMap((item)=>[{kind:'code' as const,value:item.lineStation.stationCode},{kind:'code' as const,value:`${item.line.code}${item.lineStation.stationCode}`}])
]};}
function assetDocument(profile:AssetDirectoryProfile):SearchDocument{return{reference:assetReference(profile),fields:[...(profile.asset.assetCode?[{kind:'code' as const,value:profile.asset.assetCode}]:[]),{kind:'name',value:profile.asset.displayName},...profile.aliases.map((alias)=>({kind:'alias' as const,value:alias.alias}))]};}

function bestCandidate(query:string,document:SearchDocument):EntityResolutionCandidate|null{
  let best:EntityMatchEvidence|null=null;
  for(const field of document.fields){const evidence=scoreField(query,field);if(evidence&&(!best||evidence.score>best.score))best=evidence;}
  return best?{reference:document.reference,match:best}:null;
}

function scoreField(query:string,field:MatchField):EntityMatchEvidence|null{
  const rawQuery=normalizeText(query),rawValue=normalizeText(field.value);
  if(!rawQuery||!rawValue)return null;
  if(field.kind==='code'&&normalizeCodeText(query)===normalizeCodeText(field.value))return{type:'code',score:100,matchedField:'code',matchedValue:field.value};
  if(rawQuery===rawValue){const type:EntityMatchType=field.kind==='name'?'name':'alias';return{type,score:field.kind==='name'?98:96,matchedField:field.kind,matchedValue:field.value};}
  const normalizedQuery=field.normalization?normalizeEntityName(query,field.normalization.entityType,field.normalization.subtype):rawQuery;
  const normalizedValue=field.normalization?normalizeEntityName(field.value,field.normalization.entityType,field.normalization.subtype):rawValue;
  if(normalizedQuery&&normalizedQuery===normalizedValue)return{type:'normalized',score:94,matchedField:field.kind,matchedValue:field.value};
  if(codePointLength(normalizedQuery)<2||codePointLength(normalizedValue)<2)return null;
  if(normalizedQuery.includes(normalizedValue)||normalizedValue.includes(normalizedQuery))return{type:'contains',score:85-Math.min(10,Math.abs(codePointLength(normalizedValue)-codePointLength(normalizedQuery))),matchedField:field.kind,matchedValue:field.value};
  if(field.kind==='code')return null;
  const distance=minimumWindowDistance(normalizedQuery,normalizedValue),threshold=typoThreshold(Math.min(codePointLength(normalizedQuery),codePointLength(normalizedValue)));
  return distance<=threshold?{type:'typo',score:70-distance*5,matchedField:field.kind,matchedValue:field.value}:null;
}

export function normalizeEntityText(value:string){return normalizeText(value);}
export function entityEditDistance(left:string,right:string){return levenshtein([...normalizeText(left)],[...normalizeText(right)]);}

function normalizeEntityName(value:string,type:EntityType,subtype?:string){const normalized=normalizeText(value);if(type==='location'&&subtype==='station')return normalized.replace(/站$/u,'');if(type==='organization'){
  const suffixes:Record<string,RegExp>={company:/公司$/u,operations_center:/(运营中心|中心)$/u,department:/部门$/u,station_area:/站区$/u,workgroup:/(工班|班组)$/u,station_organization:/站$/u};return subtype&&suffixes[subtype]?normalized.replace(suffixes[subtype],''):normalized;
}return normalized;}
function normalizeText(value:string){return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}_]+/gu,'');}
function normalizeCodeText(value:string){return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,'');}
function minimumWindowDistance(left:string,right:string){const a=[...left],b=[...right];if(a.length===b.length)return levenshtein(a,b);const [shorter,longer]=a.length<b.length?[a,b]:[b,a];let best=levenshtein(shorter,longer);for(let size=Math.max(1,shorter.length-1);size<=Math.min(longer.length,shorter.length+1);size++){for(let start=0;start+size<=longer.length;start++)best=Math.min(best,levenshtein(shorter,longer.slice(start,start+size)));}return best;}
function levenshtein(left:string[],right:string[]){const previous=Array.from({length:right.length+1},(_,i)=>i);for(let i=1;i<=left.length;i++){let diagonal=previous[0];previous[0]=i;for(let j=1;j<=right.length;j++){const above=previous[j],cost=left[i-1]===right[j-1]?0:1;previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+cost);diagonal=above;}}return previous[right.length];}
function typoThreshold(length:number){if(length<2)return 0;if(length<=4)return 1;return Math.max(1,Math.floor(length*0.25));}
function codePointLength(value:string){return[...value].length;}

function personReference(profile:PersonDirectoryProfile):PersonReference{return{entityType:'person',id:profile.person.id,displayName:profile.person.name,employeeNo:profile.person.employeeNo,organization:{id:profile.organizationUnit.id,code:profile.organizationUnit.code,name:profile.organizationUnit.name},position:{id:profile.position.id,code:profile.position.code,name:profile.position.name}};}
function organizationReference(item:OrganizationUnit):OrganizationReference{return{entityType:'organization',id:item.id,displayName:item.name,code:item.code,shortName:item.shortName,unitType:item.unitType,parentId:item.parentId};}
function locationReference(profile:LocationDirectoryProfile):LocationReference{return{entityType:'location',id:profile.location.id,displayName:profile.location.name,code:profile.location.code,shortName:profile.location.shortName,locationType:profile.location.locationType,lineCodes:profile.stationLines.map((item)=>item.line.code),stationCodes:profile.stationLines.map((item)=>item.lineStation.stationCode)};}
function assetReference(profile:AssetDirectoryProfile):AssetReference{return{entityType:'asset',id:profile.asset.id,displayName:profile.asset.displayName,assetCode:profile.asset.assetCode,system:{id:profile.system.id,code:profile.system.code,name:profile.system.name},type:{id:profile.type.id,code:profile.type.code,name:profile.type.name},locationId:profile.asset.locationId,lifecycleState:profile.asset.lifecycleState};}

function personEligible(profile:PersonDirectoryProfile,filters:PersonResolutionFilters={}){return profile.person.employmentStatus==='active'&&profile.organizationUnit.status==='active'&&profile.position.status==='active'&&(!filters.organizationUnitId||profile.person.organizationUnitId===filters.organizationUnitId)&&(!filters.positionId||profile.person.positionId===filters.positionId);}
function organizationEligible(item:OrganizationUnit,filters:OrganizationResolutionFilters={}){return item.status==='active'&&(!filters.unitTypes?.length||filters.unitTypes.includes(item.unitType))&&(!filters.parentOrganizationUnitId||item.parentId===filters.parentOrganizationUnitId);}
function locationEligible(profile:LocationDirectoryProfile,filters:LocationResolutionFilters={}){return profile.location.status==='active'&&(!filters.locationType||profile.location.locationType===filters.locationType)&&(!filters.lineId||profile.stationLines.some((item)=>item.line.id===filters.lineId&&item.line.status==='active'&&item.lineStation.status==='active'));}
function assetEligible(profile:AssetDirectoryProfile,filters:AssetResolutionFilters={}){const states=filters.lifecycleStates?.length?filters.lifecycleStates:['planned','active','suspended'];return states.includes(profile.asset.lifecycleState)&&profile.system.status==='active'&&profile.type.status==='active'&&(!profile.category||profile.category.status==='active')&&(!filters.systemId||profile.asset.systemId===filters.systemId)&&(!filters.typeId||profile.asset.typeId===filters.typeId)&&(!filters.locationId||profile.asset.locationId===filters.locationId);}

function normalizePersonFilters(filters:PersonResolutionFilters={}):PersonResolutionFilters{return{organizationUnitId:filters.organizationUnitId?uuid(filters.organizationUnitId,'organization id'):undefined,positionId:filters.positionId?uuid(filters.positionId,'position id'):undefined};}
function normalizeOrganizationFilters(filters:OrganizationResolutionFilters={}):OrganizationResolutionFilters{const unitTypes=filters.unitTypes?.length?[...new Set(filters.unitTypes)]:undefined;if(unitTypes?.some((type)=>!ORGANIZATION_UNIT_TYPES.includes(type)))throw new EntityResolutionError('INVALID_ORGANIZATION_TYPE','组织类型过滤无效');return{unitTypes,parentOrganizationUnitId:filters.parentOrganizationUnitId?uuid(filters.parentOrganizationUnitId,'parent organization id'):undefined};}
function normalizeLocationFilters(filters:LocationResolutionFilters={}):LocationResolutionFilters{if(filters.locationType&&!LOCATION_TYPES.includes(filters.locationType))throw new EntityResolutionError('INVALID_LOCATION_TYPE','位置类型过滤无效');return{locationType:filters.locationType,lineId:filters.lineId?uuid(filters.lineId,'line id'):undefined};}
function normalizeAssetFilters(filters:AssetResolutionFilters={}):AssetResolutionFilters{const lifecycleStates=filters.lifecycleStates?.length?[...new Set(filters.lifecycleStates)]:undefined;if(lifecycleStates?.some((state)=>!ASSET_LIFECYCLE_STATES.includes(state)))throw new EntityResolutionError('INVALID_ASSET_LIFECYCLE','资产生命周期过滤无效');return{systemId:filters.systemId?uuid(filters.systemId,'asset system id'):undefined,typeId:filters.typeId?uuid(filters.typeId,'asset type id'):undefined,locationId:filters.locationId?uuid(filters.locationId,'asset location id'):undefined,lifecycleStates};}

function directResult(request:EntityResolutionRequest,input:string,reference:EntityReference|null,match:EntityMatchEvidence|null):EntityResolutionResult{const normalizedInput=normalizeText(input);if(!reference||!match)return{status:'not_found',entityType:request.entityType,source:request.source,input,normalizedInput,candidateCount:0,candidates:[],resolved:null};const candidate={reference,match};return{status:'resolved',entityType:request.entityType,source:request.source,input,normalizedInput,candidateCount:1,candidates:[candidate],resolved:candidate};}
function rankedResult(request:EntityResolutionRequest,input:string,all:EntityResolutionCandidate[],limit:number):EntityResolutionResult{const candidates=all.slice(0,limit),base={entityType:request.entityType,source:request.source,input,normalizedInput:normalizeText(input),candidateCount:all.length,candidates};if(all.length===0)return{...base,status:'not_found',resolved:null};if(all.length===1)return{...base,status:'resolved',resolved:all[0]};return{...base,status:'ambiguous',resolved:null};}
function compareCandidates(a:EntityResolutionCandidate,b:EntityResolutionCandidate){return b.match.score-a.match.score||a.reference.displayName.localeCompare(b.reference.displayName,'zh-CN')||a.reference.id.localeCompare(b.reference.id);}

function validateRequest(request:EntityResolutionRequest){if(!['person','organization','location','asset'].includes(request.entityType))throw new EntityResolutionError('ENTITY_TYPE_REQUIRED','调用方必须指定实体类型');if(!['web','import','agent','mcp'].includes(request.source))throw new EntityResolutionError('INVALID_SOURCE','解析来源无效');maxCandidates(request.maxCandidates);if(request.lookup.type==='text')requiredText(request.lookup.text,'entity query',200);}
function maxCandidates(value:number|undefined){const normalized=value??20;if(!Number.isSafeInteger(normalized)||normalized<1||normalized>100)throw new EntityResolutionError('INVALID_CANDIDATE_LIMIT','候选数量必须在 1 到 100 之间');return normalized;}
function requiredText(value:string,label:string,max:number){const normalized=value.trim();if(!normalized||normalized.length>max)throw new EntityResolutionError('INVALID_TEXT',`${label} 无效`);return normalized;}
function stableCode(value:string,label:string){const normalized=value.trim().toLowerCase();if(!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)||normalized.length>100)throw new EntityResolutionError('INVALID_CODE',`${label} 必须是稳定编码`);return normalized;}
function uuid(value:string,label:string){const normalized=value.trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized))throw new EntityResolutionError('INVALID_ID',`${label} 必须是 UUID`);return normalized;}
