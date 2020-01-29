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

import { QueryCtrl } from 'app/plugins/sdk';
import _ from 'lodash';
import HeroicQuery from './heroic_query';
import { MetadataClient } from './metadata_client';
import { HeroicValidator } from './validator';
import { QueryParser } from './query_parser';
import queryPart from './query_part';
import { DataSeries, RenderedQuery, Target, Tag, Category, CategoryItem, QueryPart, Part } from './types';
import HeroicSeries from './heroic_series';

export class HeroicQueryCtrl extends QueryCtrl {
  static templateUrl = 'partials/query.editor.html';

  queryModel: HeroicQuery;
  groupBySegment: any;
  resultFormats: any[];
  panelCtrl: any;
  selectMenu: any;
  target: Target;
  metadataClient: MetadataClient;
  previousQuery: any;
  warningMessage: string;
  validator: HeroicValidator;
  queryParser: QueryParser;
  currentSuggestions: any[];
  aliasCompleterCache: string[];
  dataList: DataSeries[];

  /** @ngInject **/
  constructor($scope, $injector, private templateSrv, private $q, private uiSegmentSrv) {
    super($scope, $injector);
    this.target.alias = this.target.alias || '';
    if (this.target.globalAggregation !== undefined) {
      this.target.globalAggregation = this.target.globalAggregation;
    } else {
      this.target.globalAggregation = true;
    }

    this.panelCtrl.events.on('data-received', this.onDataReceived.bind(this), $scope);

    this.queryModel = new HeroicQuery(this.target, templateSrv, this.panel.scopedVars || {});
    this.groupBySegment = this.uiSegmentSrv.newPlusButton();
    this.resultFormats = [
      { text: 'Time series', value: 'time_series' },
      { text: 'Table', value: 'table' },
    ];
    this.previousQuery = this.target.query;
    this.buildSelectMenu();

    this.warningMessage = '';
    this.validator = new HeroicValidator(this.target, this.datasource.tagAggregationChecks, this.datasource.tagCollapseChecks);
    this.queryParser = new QueryParser();
    this.currentSuggestions = [];
    this.metadataClient = new MetadataClient(this, this.datasource, this.panel.scopedVars, this.target, true, false);
    this.aliasCompleterCache = [];
  }

  public toggleEditorMode() {
    this.target.rawQuery = !this.target.rawQuery;
    if (this.target.rawQuery) {
      this.target.queryRaw = JSON.stringify(JSON.parse(this.target.query), null, 2);
    }
  }
  public buildSelectMenu() {
    const categories = queryPart.getCategories();
    this.selectMenu = _.reduce(
      categories,
      function (memo, cat, key) {
        const menu = {
          text: key,
          submenu: cat.map(item => {
            return { text: item.type, value: item.type };
          }),
        };
        memo.push(menu);
        return memo;
      },
      []
    );
  }

  public addSelectPart(selectParts, cat: Category, subitem: CategoryItem, position) {
    this.queryModel.addSelectPart(selectParts, cat.text, subitem.value, position);
    if (cat.text === 'Filters') {
      this.target.globalAggregation = false;
    }
    this.refresh();
  }

  public getAliasCompleter() {
    return {
      getCompletions: (editor, session, pos, prefix, callback) => {
        callback(null, this.aliasCompleterCache);
      },
    };
  }

  public handleSelectPartEvent(selectParts, part, evt) {
    switch (evt.name) {
      case 'get-param-options': {
        return this.metadataClient.tagKeyCount({ type: 'key' }, 0, null, true);
      }
      case 'part-param-changed': {
        this.refresh();
        break;
      }
      case 'action': {
        if (evt.action.value === 'remove-part') {
          this.queryModel.removeSelectPart(selectParts, part);
          this.refresh();
        } else {
          const category = _.find(this.selectMenu, menu => menu.text === evt.action.value);
          const newPart = _.find(category.submenu, item => item.value === part.part.type);
          const position = selectParts.indexOf(part);
          this.queryModel.removeSelectPart(selectParts, part);
          this.addSelectPart(selectParts, category, newPart, position);
          this.refresh();
        }
        break;
      }
      case 'get-part-actions': {
        if (part.part.categoryName === 'Filters') {
          return this.$q.when([{ text: 'Remove', value: 'remove-part' }]);
        } else {
          return this.$q.when([
            { text: 'Remove', value: 'remove-part' },
            { text: 'Convert To Collapse', value: 'Collapse' },
            { text: 'Convert To For Each', value: 'For Each' },
            { text: 'Convert To Group By', value: 'Group By' },
          ]);
        }
      }
    }
  }

  public refresh() {
    this.queryModel.scopedVars['interval'] = { value: this.panelCtrl.interval };
    this.queryModel.scopedVars['__interval'] = { value: this.panelCtrl.interval };
    this.checkSuggestions();
    this.checkGlobalAggregation();
    const query: RenderedQuery = this.queryModel.render();
    this.target.query = JSON.stringify(query);
    this.previousQuery = this.target.query;
    if (this.panelCtrl.onQueryChange) {
      this.panelCtrl.onQueryChange();
    }
  }

  public refreshRaw() {
    this.queryParser.parseInto(this.target.queryRaw, this.target);
    this.queryModel.updateProjection();
    this.metadataClient.createTagSegments();
    this.refresh();
  }

  public appendSuggestion(suggestion) {
    this.currentSuggestions = [];
    const queryRaw = JSON.parse(this.target.query);
    queryRaw.filter = queryRaw.filter.concat(suggestion.filter);
    if (suggestion.aggregation !== undefined && suggestion.aggregation !== null && queryRaw.aggregators.length === 0) {
      queryRaw.aggregators = queryRaw.aggregators.concat(suggestion.aggregation);
    }
    this.target.queryRaw = JSON.stringify(queryRaw, null, 2);
    this.refreshRaw();
  }

  public checkSuggestions() {
    const suggestions = [];
    const query: RenderedQuery = this.queryModel.render();
    this.datasource.suggestionRules.forEach(rule => {
      const rule2 = _.cloneDeep(rule);
      rule2.triggerFilter = rule2.triggerFilter.map(item => {
        if (_.isArray(item) && item[item.length - 1] === '*') {
          const key = item[item.length - 2];
          const value = _.first(
            query.filter.filter(item => _.isArray(item) && item[item.length - 2] === key).map(item => item[item.length - 1])
          );
          item[item.length - 1] = value;
        }
        return item;
      });
      if (_.isEqual(_.sortBy(rule2.triggerFilter), _.sortBy(query.filter))) {
        suggestions.push(rule2);
      }
    });
    this.currentSuggestions = suggestions;
  }

  public checkGlobalAggregation(): void {
    this.queryModel.selectModels.forEach((model: QueryPart[]) => {
      model.forEach((queryPart: QueryPart) => {
        if (this.target.globalAggregation && queryPart.part.categoryName === 'Filters') {
          this.warningMessage = 'Filters are not compatible with Global Aggregations.';
        }
      });
    });
  }

  public clearWarnings() {
    this.warningMessage = '';
  }

  public onDataReceived(dataList: DataSeries[]) {
    dataList = dataList.filter(series => series.meta !== undefined && series.meta.isHeroicSeries);
    this.dataList = dataList;

    if (this.target.resultFormat === 'time_series') {
      this.warningMessage = this.validator.checkForWarnings(dataList);

      const filtered: DataSeries[] = dataList.filter(data => data.refId === this.target.refId);
      const scoped = _.uniq(_.flatMap(filtered, data => Object.keys(data.meta.scoped)));
      this.aliasCompleterCache = scoped.map(scope => {
        return { name: scope, value: `[[${scope}]]` };
      });
    }
  }

  public refreshAlias() {
    if (this.dataList === undefined) {
      // Some third party panel
      this.queryModel.scopedVars['interval'] = { value: this.panelCtrl.interval };
      this.queryModel.scopedVars['__interval'] = { value: this.panelCtrl.interval };
      return;
    }
    this.dataList.forEach(data => {
      if (data.refId === this.target.refId) {
        const alias = this.templateSrv.replaceWithText(this.target.alias || '$tags', {});
        data.target = this.templateSrv.replaceWithText(alias, data.meta.scoped);
      }
    });
    // Shortcut to re-render the existing data
    this.panelCtrl.events.emit('data-received', this.dataList);
  }

  public handleGroupByPartEvent(part, index, evt) {
    switch (evt.name) {
      case 'get-param-options': {
        return this.metadataClient.getTagsOrValues({ type: 'key' }, 0, null, false);
      }
      case 'part-param-changed': {
        this.refresh();
        break;
      }
      case 'action': {
        this.queryModel.removeGroupByPart(part, index);
        this.refresh();
        break;
      }
      case 'get-part-actions': {
        if (part.def.type === 'time') {
          return Promise.resolve([]);
        }
        return this.$q.when([{ text: 'Remove', value: 'remove-part' }]);
      }
    }
  }

  public getCollapsedText() {
    return this.target.query;
  }

  public getTags(): Tag[] {
    return this.target.tags;
  }

  public setTags(tags: Tag[]) {
    this.target.tags = tags;
  }
}
