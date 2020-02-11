/*
 * -\-\-
 * Spotify Heroic Grafana Datasource
 * --
 * Copyright (C) 2018 Spotify AB
 * --
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * -/-/-
 */

import angular from 'angular';
import _ from 'lodash';
import HeroicQuery from './heroic_query';
import { LruCache } from './lru_cache';

export class MetadataClient {
  public static templateUrl = 'partials/query.editor.html';
  public static DEBOUNCE_MS = 300; // milliseconds to wait between keystrokes before sending queries for metadata

  public queryModel: HeroicQuery;
  public lruTag: any;
  public lruTagValue: any;
  public lruKey: any;
  public lruTagKeyCount: any;
  public error: any;
  public complexError: any;
  public addCustomQuery: any;
  public removeTagFilterSegment: any;
  public tagSegments: any[];
  public customTagSegments: any[];

  /** @ngInject **/
  constructor(private controller, private datasource, private scopedVars, private target, private includeVariables, private includeScopes) {
    this.tagSegments = [];
    this.customTagSegments = [];
    this.createTagSegments();
    this.lruTag = new LruCache();
    this.lruTagValue = new LruCache();
    this.lruKey = new LruCache();
    this.lruTagKeyCount = new LruCache();
    this.queryModel = new HeroicQuery(this.target, this.controller.templateSrv, this.scopedVars);
    this.includeVariables = includeVariables;
    this.includeScopes = includeScopes;
    this.addCustomQuery = this.controller.uiSegmentSrv.newPlusButton();
    this.removeTagFilterSegment = this.controller.uiSegmentSrv.newSegment({
      fake: true,
      value: '-- remove --',
    });
  }

  public createTagSegments() {
    const tagSegments = [];
    const customTagSegments = [];

    if (!this.controller.fakeController) {
      const controllerTags = this.controller.getTags();
      controllerTags.sort((a, b) => {
        if (a.key === '$key' && b.key === '$key') {
          return 0;
        } else if (a.key === '$key') {
          return -1;
        } else if (b.key === '$key') {
          return 1;
        }
        return 0;
      });
      controllerTags.forEach((tag, index) => {
        if (index > 0) {
          tag.condition = 'AND';
        } else {
          delete tag.condition;
        }
      });
      for (const tag of controllerTags) {
        if (tag.type && tag.type === 'custom') {
          const newSeg = this.controller.uiSegmentSrv.newSegment({ value: tag.key, expandable: false });
          newSeg.valid = true;
          customTagSegments.push(newSeg);
          continue;
        }
        if (!tag.operator) {
          tag.operator = '=';
        }

        if (tag.condition) {
          tagSegments.push(this.controller.uiSegmentSrv.newCondition(tag.condition));
        }

        tagSegments.push(this.controller.uiSegmentSrv.newKey(tag.key));
        tagSegments.push(this.newLockedOperator(tag.operator));
        tagSegments.push(this.controller.uiSegmentSrv.newKeyValue(tag.value));
      }
      this.tagSegments = tagSegments;
      this.customTagSegments = customTagSegments;
      this.fixTagSegments();
    }
  }

  public fixTagSegments() {
    const count = this.tagSegments.length;
    const lastSegment = this.tagSegments[Math.max(count - 1, 0)];

    if (!lastSegment || lastSegment.type !== 'plus-button') {
      this.tagSegments.push(this.controller.uiSegmentSrv.newPlusButton());
    }
  }

  public getMeasurements = measurementFilter => {
    const filter = {
      key: measurementFilter,
      filter: this.queryModel.buildCurrentFilter(this.includeVariables, this.includeScopes),
      limit: 100,
    };
    const cacheKey = JSON.stringify(filter);
    if (this.lruKey.has(cacheKey)) {
      return Promise.resolve(this.lruKey.get(cacheKey));
    }
    return this.datasource
      .doRequest('/metadata/key-suggest', { method: 'POST', data: filter })
      .then(result => {
        return this.transformToSegments(true, 'key')(result.data.suggestions);
      })
      .then(result => {
        this.lruKey.put(cacheKey, result);
        return result;
      });
  };

  public handleQueryError(err) {
    this.error = err.message || 'Failed to issue metric query';
    return [];
  }

  public transformToSegments(addTemplateVars, segmentKey) {
    return results => {
      const segments = _.map(results, segment => {
        return this.controller.uiSegmentSrv.newSegment({
          value: segment[segmentKey],
          expandable: false,
        });
      });

      if (addTemplateVars) {
        for (const variable of this.controller.templateSrv.variables) {
          segments.unshift(
            this.controller.uiSegmentSrv.newSegment({
              value: '$' + variable.name,
              expandable: false,
            })
          );
        }
      }

      const keyIsMissing = this.tagSegments.find(({ type, value }) => type === 'key' && value === '$key') === undefined;

      if (segmentKey === 'key' && keyIsMissing) {
        segments.unshift(
          this.controller.uiSegmentSrv.newSegment({
            value: '$key',
            expandable: false,
          })
        );
      }
      return segments;
    };
  }

  public queryTagsAndValues(data, dedupe, cache) {
    const cacheKey = JSON.stringify(data);
    if (cache.has(cacheKey)) {
      return Promise.resolve(cache.get(cacheKey));
    }
    return this.datasource
      .doRequest('/metadata/tag-suggest', { method: 'POST', data: data })
      .then(({ data }) => {
        const suggestions = _.uniqBy(data.suggestions, suggestion => suggestion[dedupe]);
        cache.put(cacheKey, suggestions);
        return suggestions;
      });
  }

  public newLockedOperator = operator => {
    return this.controller.uiSegmentSrv.newSegment({
      value: operator,
      type: 'operator',
      cssClass: 'query-segment-operator',
      custom: 'false',
    });
  };

  public tagKeyCount = (segment, index, $query, includeRemove) => {
    // this is separate from getTagsOrValues because since this does not take in
    // a user input prefix to search for, it can return every tag for a series
    // under a specific filter

    // this is not ideal -- how can we pass query from metric-segment-wrapper to the child getOptions
    const query = $query || segment.query;

    let tagsCopy = [...this.queryModel.target.tags];
    let key;
    let operator;
    let value;
    key = segment.value;
    operator = this.tagSegments[index + 1].value;
    value = this.tagSegments[index + 2].value;
    const item = _.findIndex(this.queryModel.target.tags, tag => {
      return tag.operator === operator && tag.key === key && tag.value === value;
    });
    const filter = this.queryModel.buildFilter(tagsCopy, this.includeVariables, this.includeScopes); // do not include scoped variables

    const data = {
      filter: filter,
      limit: 100,
    };
    const cache = this.lruTagKeyCount;
    const cacheKey = JSON.stringify(data);
    if (cache.has(cacheKey)) {
      return Promise.resolve(cache.get(cacheKey));
    }
    // TODO: would be nice to display counts with tagkeys here, but label vs value not supported by metric-segment yet
    return this.datasource
      .doRequest('/metadata/tagkey-count', { method: 'POST', data: data })
      .then(result => {
        const seen = new Set();
        return result.data.suggestions;
      })
      .then(this.transformToSegments(true, 'key'))
      .then(results => {
        if (segment.type === 'key' && includeRemove) {
          results.splice(0, 0, angular.copy(this.removeTagFilterSegment));
        }
        cache.put(cacheKey, results);
        return results;
      });
  };

  public getTagsOrValues = (segment, index, $query, includeRemove) => {
    // this is not ideal -- how can we pass query from metric-segment-wrapper to the child getOptions
    const query = $query || segment.query;
    if (segment.type === 'condition') {
      return this.controller.$q.when([this.controller.uiSegmentSrv.newCondition('AND')]);
    }
    if (segment.type === 'operator') {
      const nextValue = this.tagSegments[index + 1].value;
      const operators = ['=', '!=', '^', '!^'].map(this.newLockedOperator);
      return this.controller.$q.when(operators);
    }
    let tagsCopy = [...this.queryModel.target.tags];
    if (segment.type === 'value' || segment.type === 'key') {
      let key;
      let operator;
      let value;
      if (segment.type === 'key') {
        key = segment.value;
        operator = this.tagSegments[index + 1].value;
        value = this.tagSegments[index + 2].value;
      } else {
        key = this.tagSegments[index - 2].value;
        operator = this.tagSegments[index - 1].value;
        value = segment.value;
      }

      const item = _.findIndex(this.queryModel.target.tags, tag => {
        return tag.operator === operator && tag.key === key && tag.value === value;
      });
      tagsCopy.splice(item, 1);
    }
    const filter = this.queryModel.buildFilter(tagsCopy, this.includeVariables, this.includeScopes); // do not include scoped variables

    const data = {
      filter: filter,
      limit: 100,
      key: null,
    };
    if (segment.type === 'key' || segment.type === 'plus-button') {
      data.key = query;

      return this.queryTagsAndValues(data, 'key', this.lruTag)
        .then(this.transformToSegments(true, 'key'))
        .then(results => {
          if (segment.type === 'key' && includeRemove) {
            results.splice(0, 0, angular.copy(this.removeTagFilterSegment));
          }
          return results;
        });
    } else if (segment.type === 'value') {
      const key = this.tagSegments[index - 2].value;
      if (key === '$key') {
        return this.getMeasurements(query);
      }
      data.key = key;
      data['value'] = query;
      return this.queryTagsAndValues(data, 'value', this.lruTagValue).then(this.transformToSegments(true, 'value'));
    }
  };

  public getTagValueOperator(tagValue, tagOperator): string {
    if (tagOperator !== '=~' && tagOperator !== '!~' && /^\/.*\/$/.test(tagValue)) {
      return '=~';
    } else if ((tagOperator === '=~' || tagOperator === '!~') && /^(?!\/.*\/$)/.test(tagValue)) {
      return '=';
    }
    return null;
  }

  public tagSegmentUpdated(segment, index) {
    this.tagSegments[index] = segment;
    // AND, Z, =, A, AND, B, =, C,  AND, D, =,  E]
    // 3  , 4, 5, 6, 7,   8, 9, 10, 11, 12, 13, 14]

    // handle remove tag condition
    if (segment.value === this.removeTagFilterSegment.value) {
      this.tagSegments.splice(index, 3);
      if (this.tagSegments.length === 0) {
        this.tagSegments.push(this.controller.uiSegmentSrv.newPlusButton());
      } else if (this.tagSegments.length > 2) {
        this.tagSegments.splice(Math.max(index - 1, 0), 1);
        if (this.tagSegments[this.tagSegments.length - 1].type !== 'plus-button') {
          this.tagSegments.push(this.controller.uiSegmentSrv.newPlusButton());
        }
      }
    } else {
      if (segment.type === 'plus-button') {
        if (index > 2) {
          this.tagSegments.splice(index, 0, this.controller.uiSegmentSrv.newCondition('AND'));
        }
        this.tagSegments.push(this.newLockedOperator('='));
        this.tagSegments.push(this.controller.uiSegmentSrv.newFake('select tag value', 'value', 'query-segment-value'));
        this.tagSegments[this.tagSegments.length - 1].focus = true;
        segment.type = 'key';
        segment.cssClass = 'query-segment-key';
      }

      if (index + 1 === this.tagSegments.length) {
        this.tagSegments.push(this.controller.uiSegmentSrv.newPlusButton());
        this.tagSegments[this.tagSegments.length - 1].focus = true;
      }
    }

    this.rebuildTargetTagConditions();
  }

  public rebuildTargetTagConditions() {
    const tags = [];
    let tagIndex = 0;
    let tagOperator = '';

    _.each(this.tagSegments, (segment2, index) => {
      if (segment2.type === 'key') {
        if (tags.length === 0) {
          tags.push({});
        }
        tags[tagIndex].key = segment2.value;
      } else if (segment2.type === 'value') {
        tagOperator = this.getTagValueOperator(segment2.value, tags[tagIndex].operator);
        if (tagOperator) {
          this.tagSegments[index - 1] = this.controller.uiSegmentSrv.newOperator(tagOperator);
          tags[tagIndex].operator = tagOperator;
        }
        tags[tagIndex].value = segment2.value;
      } else if (segment2.type === 'condition') {
        tags.push({ condition: segment2.value });
        tagIndex += 1;
      } else if (segment2.type === 'operator') {
        tags[tagIndex].operator = segment2.value;
      }
    });
    _.each(this.customTagSegments, (segment, index) => {
      if (segment.valid) {
        tags.push({ operator: 'q', type: 'custom', key: segment.value });
      }
    });
    this.controller.setTags(tags);
    this.controller.refresh();
  }

  public validateCustomQuery = _.debounce(
    (segment, index, query, includeRemove) => {
      segment.style = { color: 'red' };
      const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
      return this.datasource
        .doRequestWithHeaders('/parser/parse-filter', { method: 'POST', data: query }, headers)
        .then(
          result => {
            segment.valid = true;
            segment.cssClass = '';
            this.complexError = null;
            return [];
          },
          error => {
            segment.valid = false;
            segment.cssClass = 'text-error';
            this.complexError = 'Complex filter contains invalid syntax. See help dropdown.';
            return [];
          }
        )
        .then(result => {
          result.splice(0, 0, angular.copy(this.removeTagFilterSegment));
          return result;
        });
    },
    MetadataClient.DEBOUNCE_MS,
    { leading: false }
  );

  public createCustomQuery = () => {
    this.customTagSegments.push(this.controller.uiSegmentSrv.newSegment({ value: '--custom--', valid: false, expandable: false }));
  };
  public customFilterChanged = (segment, index) => {
    if (segment.value === this.removeTagFilterSegment.value) {
      this.customTagSegments.splice(index, 1);
    }
    this.rebuildTargetTagConditions();
  };
}
