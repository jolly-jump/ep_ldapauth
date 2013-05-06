// Copyright 2013 Andrew Grimberg <tykeal@bardicgrove.org>
//
// @License GPL-2.0 <http://spdx.org/licenses/GPL-2.0>

//var LdapAuth = require('ldapauth');
var MyLdapAuth = require('./lib/MyLdapAuth.js');
var util = require('util');

var ERR = require('async-stacktrace');
var settings = require('ep_etherpad-lite/node/utils/Settings');
var authorManager = require('ep_etherpad-lite/node/db/AuthorManager');

// ldapauthUsername is set by authenticate and used in messageHandler, keyed on express_sid
var ldapauthUsername = {};

function ldapauthSetUsername(token, username) {
  console.debug('ep_ldapauth.ldapauthSetUsername: getting authorid for token %s', token);
  authorManager.getAuthor4Token(token, function(err, author) {
    if (ERR(err)) {
      console.debug('ep_ldapauth.ldapauthSetUsername: have authorid %s, setting username to %s', author, username);
      authorManager.SetAuthorName(author, username);
    } else {
      console.debug('ep_ldapauth.ldapauthSetUsername: could not get authorid for token %s', token);
    }
  });
  return;
}

exports.authenticate = function(hook_name, context, cb) {
  console.debug('ep_ldapauth.authenticate');
  // If auth headers are present use them to authenticate
  if (context.req.headers.authorization && context.req.headers.authorization.search('Basic ') === 0) {
    var userpass = new Buffer(context.req.headers.authorization.split(' ')[1], 'base64').toString().split(":");
    var username = userpass[0];
    var password = userpass[1];
    var express_sid = context.req.sessionID;

    var ldap = new MyLdapAuth({
      url: settings.users.ldapauth.url,
      adminDn: settings.users.ldapauth.searchDN,
      adminPassword: settings.users.ldapauth.searchPWD,
      searchBase: settings.users.ldapauth.accountBase,
      searchFilter: settings.users.ldapauth.accountPattern,
      cache: true
    });

    // Attempt to authenticate the user
    ldap.authenticate(username, password, function(err, user) {
      if (err) {
        console.error('ep_ldapauth.authenticate: LDAP auth error: %s', err);
        return cb([false]);
      }

      // User authenticated, save off some information needed for authorization
      context.req.session.user = username;
      settings.globalUserName = username;
      console.debug('ep_ldapauth.authenticate: deferring setting of username [%s] to CLIENT_READY for express_sid = %s', username, express_sid);
      ldapauthUsername[express_sid] = username;
      return cb([true]);
    });
  } else {
    return cb([false]);
  }
}

exports.authorize = function(hook_name, context, cb) {
  console.debug('ep_ldapauth.authorize');

  var ldap = new MyLdapAuth({
    url: settings.users.ldapauth.url,
    adminDn: settings.users.ldapauth.searchDN,
    adminPassword: settings.users.ldapauth.searchPWD,
    searchBase: settings.users.ldapauth.accountBase,
    searchFilter: settings.users.ldapauth.accountPattern,
    groupSearchBase: settings.users.ldapauth.groupSearchBase,
    groupAttribute: settings.users.ldapauth.groupAttribute,
    groupAttributeIsDN: settings.users.ldapauth.groupAttributeIsDN,
    searchScope: settings.users.ldapauth.searchScope,
    groupSearch: settings.users.ldapauth.groupSearch,
    cache: true
  });

  username = context.req.session.user;

  if (context.resource.match(/^\/(static|javascripts|pluginfw|favicon.ico|api)/)) {
    console.debug('ep_ldapauth.authorize: authorizing static path %s', context.resource);
    return cb([true]);
  } else if (context.resource.match(/^\/admin/)) {
    console.debug('ep_ldapauth.authorize: authorizing along administrative path %s', context.resource);
    ldap.groupsearch(username, function(err, groups) {
      if (err) {
        console.error('ep_ldapauth.authorize: LDAP groupsearch error: %s', err);
        return cb([false]);
      }

      // We've recieved back group(s) that the user matches
      // Given our current auth scheme (only checking on admin) we'll auth
      if (groups)
        return cb([true]);
      else
        return cb([false]);
    });
  } else {
    console.debug('ep_ldapauth.authorize: passing authorize along for path %s', context.resource);
    return cb([false]);
  }
}

exports.handleMessage = function(hook_name, context, cb) {
  console.debug("ep_ldapauth.handleMessage");
  if ( context.message.type == "CLIENT_READY" ) {
    if (!context.message.token) {
      console.debug('ep_ldapauth.handleMessage: intercepted CLIENT_READY message has no token!');
    } else {
      var client_id = context.client.id;
      var express_sid = context.client.manager.handshaken[client_id].sessionID;
      console.debug('ep_ldapauth.handleMessage: intercepted CLIENT_READY message for client_id = %s express_sid = %s, setting username for token %s to %s', client_id, express_sid, context.message.token, ldapauthUsername);
      ldapauthSetUsername(context.message.token, ldapauthUsername[express_sid]);
    }
  } else if ( context.message.type == "COLLABROOM" && context.message.data.type == "USERINFO_UPDATE" ) {
    console.debug('ep_ldapauth.handleMessage: intercepted USERINFO_UPDATE and dropping it!');
    return cb([null]);
  }
  return cb([context.message]);
}

// vim: sw=2 ts=2 sts=2 et ai