module.exports = (sequelize, DataTypes) => {
  const ContradictionCheck = sequelize.define('ContradictionCheck', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the contradiction evaluation'
    },
    claim_id_1: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'First claim in the canonical claim pair'
    },
    claim_id_2: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Second claim in the canonical claim pair'
    },
    input_fingerprint: {
      type: DataTypes.CHAR(64),
      allowNull: false,
      comment: 'SHA-256 fingerprint of the classification input',
      validate: {
        is: /^[a-f0-9]{64}$/i
      }
    },
    outcome: {
      type: DataTypes.ENUM('direct', 'partial', 'temporal', 'none'),
      allowNull: false,
      comment: 'Classification result, including non-contradictions'
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Explanation of the classification result'
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'Model identifier used for classification'
    },
    prompt_version: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'Prompt version used for classification'
    },
    checked_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the claim pair was evaluated'
    }
  }, {
    tableName: 'contradiction_checks',
    timestamps: true,
    underscored: false,
    comment: 'Durable contradiction classification results for claim pairs',
    hooks: {
      beforeValidate: (instance) => {
        if (instance.claim_id_1 && instance.claim_id_2) {
          if (instance.claim_id_1 === instance.claim_id_2) {
            throw new Error('Contradiction check requires two different claims');
          }
          if (instance.claim_id_1 > instance.claim_id_2) {
            const first = instance.claim_id_1;
            instance.claim_id_1 = instance.claim_id_2;
            instance.claim_id_2 = first;
          }
        }
      }
    },
    indexes: [
      {
        name: 'idx_contradiction_checks_claim_id_1',
        fields: ['claim_id_1']
      },
      {
        name: 'idx_contradiction_checks_claim_id_2',
        fields: ['claim_id_2']
      },
      {
        name: 'idx_contradiction_checks_unique',
        fields: ['claim_id_1', 'claim_id_2', 'input_fingerprint'],
        unique: true
      },
      {
        name: 'idx_contradiction_checks_outcome',
        fields: ['outcome']
      }
    ],
    validate: {
      claimIdsOrdered() {
        if (this.claim_id_1 && this.claim_id_2 && this.claim_id_1 >= this.claim_id_2) {
          throw new Error('claim_id_1 must be less than claim_id_2');
        }
      }
    }
  });

  ContradictionCheck.associate = (models) => {
    ContradictionCheck.belongsTo(models.Claim, {
      foreignKey: 'claim_id_1',
      as: 'firstClaim',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
      hooks: true
    });
    ContradictionCheck.belongsTo(models.Claim, {
      foreignKey: 'claim_id_2',
      as: 'secondClaim',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
      hooks: true
    });
  };

  return ContradictionCheck;
};
