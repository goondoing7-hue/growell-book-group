(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellPrivateCategories = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  var FORMAT = 'growell-private-categories-v1';
  var NONE_KEY = 'private-none';
  var NONE_LABEL = '분류 없음';

  function validScopeId(value){
    return typeof value === 'string' && value.length > 0 && value === value.trim();
  }
  function recordId(userId, bookId){
    if(!validScopeId(userId) || !validScopeId(bookId)) throw new TypeError('회원과 책 정보가 필요해요.');
    return 'private_categories_' + bookId + '_' + userId;
  }
  function isSettingsEntry(entry){
    return !!entry && typeof entry === 'object' && !Array.isArray(entry) &&
      validScopeId(entry.userId) && validScopeId(entry.bookId) &&
      entry.id === recordId(entry.userId, entry.bookId);
  }
  function prepare(categories){
    if(!Array.isArray(categories)) throw new TypeError('분류 목록 형식이 올바르지 않아요.');
    if(categories.length > 20) throw new RangeError('분류는 20개까지 만들 수 있어요.');
    var ids = new Set(), labels = new Set();
    return Array.from(categories).map(function(category){
      if(!category || typeof category !== 'object' || Array.isArray(category) ||
        typeof category.id !== 'string' || !/^pcat_[A-Za-z0-9_-]+$/.test(category.id)){
        throw new TypeError('분류 정보가 올바르지 않아요.');
      }
      if(typeof category.label !== 'string') throw new TypeError('분류 이름을 입력해주세요.');
      var label = category.label.trim();
      if(!label) throw new TypeError('분류 이름을 입력해주세요.');
      if(Array.from(label).length > 30) throw new RangeError('분류 이름은 30자까지 입력할 수 있어요.');
      var normalizedLabel = label.normalize('NFC').toLowerCase();
      if(ids.has(category.id)) throw new TypeError('분류 정보가 중복되어 있어요.');
      if(labels.has(normalizedLabel)) throw new TypeError('같은 이름의 분류가 이미 있어요.');
      ids.add(category.id);
      labels.add(normalizedLabel);
      return {id:category.id, label:label};
    });
  }
  function encode(categories){
    return JSON.stringify({format:FORMAT, categories:prepare(categories)});
  }
  function decode(text){
    if(typeof text !== 'string') throw new TypeError('저장된 분류 형식이 올바르지 않아요.');
    var data = JSON.parse(text);
    if(!data || typeof data !== 'object' || Array.isArray(data) || data.format !== FORMAT){
      throw new TypeError('지원하지 않는 분류 형식이에요.');
    }
    return prepare(data.categories);
  }
  function options(categories){
    return [{key:NONE_KEY, label:NONE_LABEL}].concat(prepare(categories).map(function(category){
      return {key:category.id, label:category.label};
    }));
  }
  function key(noteType, categories){
    var found = prepare(categories).find(function(category){return category.id === noteType;});
    return found ? found.id : NONE_KEY;
  }
  function label(noteType, categories){
    var found = prepare(categories).find(function(category){return category.id === noteType;});
    return found ? found.label : NONE_LABEL;
  }

  return {recordId:recordId, isSettingsEntry:isSettingsEntry, prepare:prepare, encode:encode,
    decode:decode, options:options, key:key, label:label};
});
