export const validMonth=value=>typeof value==='string'&&/^(20\d\d|2100)-(0[1-9]|1[0-2])$/.test(value);
export const monthCycle=(cycles,value)=>validMonth(value)?cycles.find(cycle=>cycle.year===Number(value.slice(0,4))&&cycle.month===Number(value.slice(5,7)))??null:null;
