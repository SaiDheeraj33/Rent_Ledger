const knex = require('knex');
const pg = require('pg');
const knexConfig = require('../knexfile');

// Parse PostgreSQL DATE type (OID 1082) as raw 'YYYY-MM-DD' string to prevent timezone offset shifts
pg.types.setTypeParser(1082, (val) => val);

const db = knex(knexConfig);

module.exports = db;

