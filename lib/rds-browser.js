const docker = require('./docker');
const literal = value => "'" + String(value).replace(/'/g,"''") + "'";
async function browse(database, input) {
  const pg=database.engine==='postgres';
  const identifier=value=>pg?'"'+value.replace(/"/g,'""')+'"':'`'+value.replace(/`/g,'``')+'`';
  async function query(sql, fields) {
    const statement=pg?`SELECT COALESCE(json_agg(q), '[]'::json) FROM (${sql}) q;`:`SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${fields.map(f=>`${literal(f)},q.${identifier(f)}`).join(',')})),JSON_ARRAY()) FROM (${sql}) q;`;
    const args=pg?['exec','-i','-e',`PGPASSWORD=${database.password}`,database.container,'psql','-X','-A','-t','-U','lab','-d','lab','-v','ON_ERROR_STOP=1']:['exec','-i','-e',`MYSQL_PWD=${database.password}`,database.container,'mysql','--batch','--raw','--skip-column-names','--default-character-set=utf8mb4','-uroot','lab'];
    // Keep SQL out of CLI arguments and disable MySQL backslash escapes for literals.
    const result=await docker.command(args,{input:(pg?'':"SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';\n")+statement,timeout:15000,maxOutput:4*1024*1024});
    return JSON.parse(result.stdout.trim());
  }
  const tables=await query(`SELECT table_schema AS ${identifier('schema')},table_name AS ${identifier('name')} FROM information_schema.tables WHERE table_type='BASE TABLE' AND ${pg?"table_schema NOT IN ('pg_catalog','information_schema')":"table_schema=DATABASE()"} ORDER BY table_schema,table_name`,['schema','name']);
  tables.sort((a,b)=>(a.schema+'.'+a.name).localeCompare(b.schema+'.'+b.name));
  if(input.action==='tables')return {tables};
  const table=tables.find(t=>t.name===input.table&&t.schema===input.schema);if(!table)throw new Error('Table not found. Refresh the table list.');
  const columns=await query(`SELECT ordinal_position AS ${identifier('position')},column_name AS ${identifier('name')},data_type AS ${identifier('type')},is_nullable AS ${identifier('nullable')},column_default AS ${identifier('defaultValue')} FROM information_schema.columns WHERE table_schema=${literal(table.schema)} AND table_name=${literal(table.name)} ORDER BY ordinal_position`,['position','name','type','nullable','defaultValue']);
  columns.sort((a,b)=>Number(a.position)-Number(b.position));
  const limit=Number(input.limit??50),offset=Number(input.offset??0);
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000)throw new Error('Invalid page: limit 1–100; offset 0–1000000.');
  const qualified=`${identifier(table.schema)}.${identifier(table.name)}`;
  // Text cells preserve decimal/bigint precision and make binary values safe to transport.
  const expressions=columns.map(c=>{
    const col=identifier(c.name);
    return (pg?(c.type==='bytea'?`encode(${col},'hex')`:`CAST(${col} AS text)`):(['blob','binary','varbinary','tinyblob','mediumblob','longblob'].includes(c.type)?`HEX(${col})`:`CAST(${col} AS CHAR)`))+` AS ${col}`;
  });
  const rows=await query(`SELECT ${expressions.join(',')} FROM ${qualified} ORDER BY ${identifier(columns[0].name)} LIMIT ${limit} OFFSET ${offset}`,columns.map(c=>c.name));
  const count=await query(`SELECT CAST(COUNT(*) AS ${pg?'text':'CHAR'}) AS ${identifier('total')} FROM ${qualified}`,['total']);
  return {table,columns,rows,total:Number(count[0].total),limit,offset};
}
module.exports={browse};
