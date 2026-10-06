//! The few facts the store keeps about itself beside the boards (where the
//! migration from the JSON files stands, and what it was taken from).

use diesel::prelude::*;

use crate::error::Result;
use crate::schema::meta;

pub fn get(conn: &mut SqliteConnection, key: &str) -> Result<Option<String>> {
    Ok(meta::table.find(key).select(meta::value).first(conn).optional()?)
}

pub fn set(conn: &mut SqliteConnection, key: &str, value: &str) -> Result<()> {
    diesel::insert_into(meta::table)
        .values((meta::key.eq(key), meta::value.eq(value)))
        .on_conflict(meta::key)
        .do_update()
        .set(meta::value.eq(value))
        .execute(conn)?;
    Ok(())
}

pub fn delete(conn: &mut SqliteConnection, key: &str) -> Result<()> {
    diesel::delete(meta::table.find(key)).execute(conn)?;
    Ok(())
}

/// Every meta row whose key starts with `prefix`, the prefix cut off.
pub fn with_prefix(conn: &mut SqliteConnection, prefix: &str) -> Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = meta::table
        .filter(meta::key.like(format!("{}%", escape_like(prefix))).escape('\\'))
        .order(meta::key)
        .load(conn)?;
    Ok(rows.into_iter().map(|(key, value)| (key[prefix.len()..].to_string(), value)).collect())
}

pub fn delete_prefix(conn: &mut SqliteConnection, prefix: &str) -> Result<()> {
    diesel::delete(meta::table.filter(meta::key.like(format!("{}%", escape_like(prefix))).escape('\\')))
        .execute(conn)?;
    Ok(())
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}
