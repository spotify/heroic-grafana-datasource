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

import { QueryCtrl } from "app/plugins/sdk";
import _ from "lodash";
import HeroicQuery from "./heroic_query";
import { MetadataClient } from "./metadata_client";
import queryPart from "./query_part";

export class HeroicQueryCtrl extends QueryCtrl {
  public static templateUrl = "partials/query.editor.html";

  public queryModel: HeroicQuery;
  public groupBySegment: any;
  public resultFormats: any[];
  public orderByTime: any[];
  public panelCtrl: any;
  public tagSegments: any[];
  public selectMenu: any;
  public target: any;
  public measurementSegment: any;
  public removeTagFilterSegment: any;



  public metadataClient: MetadataClient;

  /** @ngInject **/
  constructor($scope, $injector, private templateSrv, private $q, private uiSegmentSrv) {
    super($scope, $injector);
    this.queryModel = new HeroicQuery(this.target, templateSrv, this.panel.scopedVars);
    this.groupBySegment = this.uiSegmentSrv.newPlusButton();
    this.resultFormats = [{ text: "Time series", value: "time_series" }, { text: "Table", value: "table" }];
    this.tagSegments = [];
    if (!this.target.measurement) {
      this.measurementSegment = uiSegmentSrv.newSelectMeasurement();
    } else {
      this.measurementSegment = uiSegmentSrv.newSegment(this.target.measurement);
    }

    for (const tag of this.target.tags) {
      if (!tag.operator) {
        if (/^\/.*\/$/.test(tag.value)) {
          tag.operator = "=~";
        } else {
          tag.operator = "=";
        }
      }

      if (tag.condition) {
        this.tagSegments.push(uiSegmentSrv.newCondition(tag.condition));
      }

      this.tagSegments.push(uiSegmentSrv.newKey(tag.key));
      this.tagSegments.push(uiSegmentSrv.newOperator(tag.operator));
      this.tagSegments.push(uiSegmentSrv.newKeyValue(tag.value));
    }

    this.fixTagSegments();
    this.buildSelectMenu();
    this.removeTagFilterSegment = uiSegmentSrv.newSegment({
      fake: true,
      value: "-- remove tag filter --",
    });
    this.metadataClient = new MetadataClient(this.datasource, this.uiSegmentSrv, this.templateSrv, this.$q, this.panel.scopedVars, this.target, this.removeTagFilterSegment, this.tagSegments, true, false);

  }

  public buildSelectMenu() {
    const categories = queryPart.getCategories();
    this.selectMenu = _.reduce(
      categories,
      function(memo, cat, key) {
        const menu = {
          text: key,
          submenu: cat.map((item) => {
            return { text: item.type, value: item.type };
          }),
        };
        memo.push(menu);
        return memo;
      },
      []
    );
  }

  public getGroupByOptions() {
    // TODO: Group By tags aggregates
    const options = [];
    options.push(this.uiSegmentSrv.newSegment({ value: "time($interval)" }));
    return Promise.resolve(options);
  }

  public groupByAction() {
    this.queryModel.addGroupBy(this.groupBySegment.value);
    const plusButton = this.uiSegmentSrv.newPlusButton();
    this.groupBySegment.value = plusButton.value;
    this.groupBySegment.html = plusButton.html;
    this.panelCtrl.refresh();
  }

  public addSelectPart(selectParts, cat, subitem) {
    this.queryModel.addSelectPart(selectParts, cat.text, subitem.value);
    this.panelCtrl.refresh();
  }

  public handleSelectPartEvent(selectParts, part, evt) {
    switch (evt.name) {
      case "get-param-options": {
        return this.metadataClient.getTagsOrValues({type: "key"}, 0, null, false);
      }
      case "part-param-changed": {
        this.panelCtrl.refresh();
        break;
      }
      case "action": {
        this.queryModel.removeSelectPart(selectParts, part);
        this.panelCtrl.refresh();
        break;
      }
      case "get-part-actions": {
        return this.$q.when([{ text: "Remove", value: "remove-part" }]);
      }
    }
  }

  public handleGroupByPartEvent(part, index, evt) {
    switch (evt.name) {
      case "get-param-options": {
        return this.metadataClient.getTagsOrValues({type: "key"}, 0, null, false);
      }
      case "part-param-changed": {
        this.panelCtrl.refresh();
        break;
      }
      case "action": {
        this.queryModel.removeGroupByPart(part, index);
        this.panelCtrl.refresh();
        break;
      }
      case "get-part-actions": {
        return this.$q.when([{ text: "Remove", value: "remove-part" }]);
      }
    }
  }

  public fixTagSegments() {
    const count = this.tagSegments.length;
    const lastSegment = this.tagSegments[Math.max(count - 1, 0)];

    if (!lastSegment || lastSegment.type !== "plus-button") {
      this.tagSegments.push(this.uiSegmentSrv.newPlusButton());
    }
  }

  public measurementChanged() {
    this.target.measurement = this.measurementSegment.value;
    this.panelCtrl.refresh();
  }

  public toggleEditorMode() {
    // TODO: do not render template variables when toggling to manual editor
    try {
      this.target.query = JSON.stringify(this.queryModel.render(), null, 2);
    } catch (err) {
      console.log("query render error");
    }
    this.target.rawQuery = !this.target.rawQuery;
  }

  public tagSegmentUpdated(segment, index) {
    this.tagSegments[index] = segment;
    // AND, Z, =, A, AND, B, =, C,  AND, D, =,  E]
    // 3  , 4, 5, 6, 7,   8, 9, 10, 11, 12, 13, 14]

    // handle remove tag condition
    if (segment.value === this.removeTagFilterSegment.value) {
      this.tagSegments.splice(index, 3);
      if (this.tagSegments.length === 0) {
        this.tagSegments.push(this.uiSegmentSrv.newPlusButton());
      } else if (this.tagSegments.length > 2) {
        this.tagSegments.splice(Math.max(index - 1, 0), 1);
        if (this.tagSegments[this.tagSegments.length - 1].type !== "plus-button") {
          this.tagSegments.push(this.uiSegmentSrv.newPlusButton());
        }
      }
    } else {
      if (segment.type === "plus-button") {
        if (index > 2) {
          this.tagSegments.splice(index, 0, this.uiSegmentSrv.newCondition("AND"));
        }
        this.tagSegments.push(this.uiSegmentSrv.newOperator("="));
        this.tagSegments.push(this.uiSegmentSrv.newFake("select tag value", "value", "query-segment-value"));
        segment.type = "key";
        segment.cssClass = "query-segment-key";
      }

      if (index + 1 === this.tagSegments.length) {
        this.tagSegments.push(this.uiSegmentSrv.newPlusButton());
      }
    }

    this.rebuildTargetTagConditions();
  }

  public rebuildTargetTagConditions() {
    const tags = [];
    let tagIndex = 0;
    let tagOperator = "";

    _.each(this.tagSegments, (segment2, index) => {
      if (segment2.type === "key") {
        if (tags.length === 0) {
          tags.push({});
        }
        tags[tagIndex].key = segment2.value;
      } else if (segment2.type === "value") {
        tagOperator = this.metadataClient.getTagValueOperator(segment2.value, tags[tagIndex].operator);
        if (tagOperator) {
          this.tagSegments[index - 1] = this.uiSegmentSrv.newOperator(tagOperator);
          tags[tagIndex].operator = tagOperator;
        }
        tags[tagIndex].value = segment2.value;
      } else if (segment2.type === "condition") {
        tags.push({ condition: segment2.value });
        tagIndex += 1;
      } else if (segment2.type === "operator") {
        tags[tagIndex].operator = segment2.value;
      }
    });

    this.target.tags = tags;
    this.panelCtrl.refresh();
  }

}
